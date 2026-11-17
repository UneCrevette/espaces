/*
 * Installeur Espaces : remet l'app à jour sur l'iPad et l'iPhone d'un clic.
 * Il lance les scripts du projet (ios/installer-sur-ipad.sh, ios/installer-sur-iphone.sh), montre où ils en sont,
 * et rappelle quand l'app va expirer (une app signée avec un identifiant Apple gratuit dure 7 jours).
 */
import SwiftUI
import Combine
import UserNotifications

enum Target: String, CaseIterable, Identifiable {
    case ipad, iphone
    var id: String { rawValue }
    var name: String { self == .ipad ? "iPad" : "iPhone" }
    var symbol: String { self == .ipad ? "ipad" : "iphone" }
    var script: String { self == .ipad ? "installer-sur-ipad.sh" : "installer-sur-iphone.sh" }
}

struct DeviceState { var name: String; var reachable: Bool; var wired: Bool }

@MainActor
final class Model: ObservableObject {
    @Published var project: String = UserDefaults.standard.string(forKey: "project") ?? Model.defaultProject
    @Published var devices: [Target: DeviceState] = [:]
    @Published var running: Target?
    @Published var queue: [Target] = []
    @Published var step = ""
    @Published var log = ""
    @Published var results: [Target: Bool] = [:]
    @Published var problem: String?
    private var process: Process?

    // le dossier du projet d'où l'Installeur a été construit (voir build.sh)
    static let defaultProject = Bundle.main.object(forInfoDictionaryKey: "EspacesProject") as? String ?? NSString(string: "~/Documents/Claude/Espaces").expandingTildeInPath
    var busy: Bool { running != nil }

    func lastInstall(_ t: Target) -> Date? { UserDefaults.standard.object(forKey: "installed." + t.rawValue) as? Date }

    // l'app gratuite expire 7 jours après l'installation
    func expiry(_ t: Target) -> String {
        guard let d = lastInstall(t) else { return "Jamais installé d'ici" }
        let left = Int(ceil(d.addingTimeInterval(7 * 86400).timeIntervalSinceNow / 86400))
        let when = d.formatted(.relative(presentation: .named))
        if left <= 0 { return "Installé \(when) · expiré, à réinstaller" }
        return "Installé \(when) · expire dans \(left) jour\(left > 1 ? "s" : "")"
    }
    func expiresSoon(_ t: Target) -> Bool {
        guard let d = lastInstall(t) else { return false }
        return d.addingTimeInterval(6 * 86400) < Date()
    }

    // MARK: appareils

    func refreshDevices() {
        Task.detached {
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("installeur-devices.json")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            p.arguments = ["devicectl", "list", "devices", "--json-output", out.path]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            var found: [Target: DeviceState] = [:]
            if let data = try? Data(contentsOf: out),
               let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let list = (root["result"] as? [String: Any])?["devices"] as? [[String: Any]] {
                for d in list {
                    let hw = d["hardwareProperties"] as? [String: Any] ?? [:]
                    let conn = d["connectionProperties"] as? [String: Any] ?? [:]
                    guard hw["reality"] as? String == "physical", let type = hw["deviceType"] as? String,
                          let t: Target = type == "iPad" ? .ipad : type == "iPhone" ? .iphone : nil else { continue }
                    let name = (d["deviceProperties"] as? [String: Any])?["name"] as? String ?? t.name
                    let state = DeviceState(name: name, reachable: conn["tunnelState"] as? String != "unavailable",
                                            wired: conn["transportType"] as? String == "wired")
                    if found[t] == nil || (state.reachable && !(found[t]!.reachable)) { found[t] = state }
                }
            }
            let result = found
            await MainActor.run { self.devices = result }
        }
    }

    // MARK: installation

    func install(_ targets: [Target]) {
        guard !busy, !targets.isEmpty else { return }
        problem = nil
        // le projet ne doit rien embarquer de ce qui sert aux essais (pages de test, crochets de débogage)
        let web = URL(fileURLWithPath: project).appendingPathComponent("web")
        let stray = ((try? FileManager.default.contentsOfDirectory(atPath: web.path)) ?? []).filter { $0.hasPrefix("_") }
        let app = (try? String(contentsOf: web.appendingPathComponent("app.js"), encoding: .utf8)) ?? ""
        if !FileManager.default.fileExists(atPath: web.appendingPathComponent("app.js").path) {
            problem = "Le projet Espaces est introuvable dans « \(project) ». Choisissez son dossier."
            return
        }
        if !stray.isEmpty || app.contains("DEBUG-TEST") {
            problem = "Le projet contient encore des fichiers d'essai (\((stray + (app.contains("DEBUG-TEST") ? ["crochet DEBUG-TEST dans app.js"] : [])).joined(separator: ", "))). Rien n'a été installé."
            return
        }
        results = [:]
        log = ""
        queue = Array(targets.dropFirst())
        run(targets[0])
    }

    private func run(_ t: Target) {
        running = t
        step = "Préparation pour l'\(t.name)…"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = [URL(fileURLWithPath: project).appendingPathComponent("ios").appendingPathComponent(t.script).path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self.absorb(s, t) }
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in self.finished(t, ok: proc.terminationStatus == 0) }
        }
        do { try p.run(); process = p } catch { finished(t, ok: false); problem = error.localizedDescription }
    }

    // les lignes des scripts deviennent l'étape en cours ; le reste (avertissements du compilateur) va dans les détails
    private func absorb(_ s: String, _ t: Target) {
        log += s
        for line in s.split(separator: "\n").map(String.init) {
            if line.hasPrefix("→ Compilation") { step = "Compilation pour l'\(t.name)… (une à deux minutes)" }
            else if line.hasPrefix("→ Installation") { step = "Installation sur l'\(t.name)…" }
            else if line.hasPrefix("En attente") { step = "En attente de l'\(t.name) : déverrouillez-le…" }
        }
    }

    private func finished(_ t: Target, ok: Bool) {
        process = nil
        results[t] = ok
        if ok { UserDefaults.standard.set(Date(), forKey: "installed." + t.rawValue) }
        else if problem == nil {
            let last = log.split(separator: "\n").map(String.init).last { $0.hasPrefix("Aucun") || $0.contains("error:") }
            problem = "L'installation sur l'\(t.name) a échoué" + (last.map { " : " + $0 } ?? ". Ouvrez les détails pour voir pourquoi.")
        }
        if let next = queue.first { queue.removeFirst(); run(next); return }
        running = nil
        step = ""
        refreshDevices()
        notify()
    }

    func cancel() {
        guard let p = process else { return }
        queue = []
        problem = "Installation arrêtée."
        // le script, et ce qu'il a lancé (xcodebuild, devicectl)
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-TERM", "-P", String(p.processIdentifier)]
        try? kill.run()
        kill.waitUntilExit()
        p.terminate()
    }

    private func notify() {
        let ok = results.filter { $0.value }.keys.map(\.name).sorted()
        let ko = results.filter { !$0.value }.keys.map(\.name).sorted()
        let c = UNMutableNotificationContent()
        c.title = ko.isEmpty ? "Espaces est à jour" : "Installation incomplète"
        c.body = [ok.isEmpty ? nil : "Installé sur : " + ok.joined(separator: ", "), ko.isEmpty ? nil : "Échec : " + ko.joined(separator: ", ")].compactMap { $0 }.joined(separator: " · ")
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "Choisissez le dossier du projet Espaces (celui qui contient « web » et « ios »)"
        if panel.runModal() == .OK, let url = panel.url {
            project = url.path
            UserDefaults.standard.set(project, forKey: "project")
            problem = nil
        }
    }
}

struct DeviceCard: View {
    @ObservedObject var model: Model
    let target: Target

    var body: some View {
        let dev = model.devices[target]
        HStack(spacing: 14) {
            Image(systemName: target.symbol)
                .font(.system(size: 30, weight: .light))
                .frame(width: 40)
                .foregroundStyle(dev?.reachable == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(dev?.name ?? target.name).font(.headline)
                HStack(spacing: 5) {
                    Circle().fill(dev?.reachable == true ? Color.green : Color.orange).frame(width: 7, height: 7)
                    Text(dev == nil ? "Jamais associé à ce Mac" : dev!.reachable ? (dev!.wired ? "Branché" : "Joignable en Wi-Fi") : "Hors de portée : déverrouillez-le")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(model.expiry(target))
                    .font(.caption)
                    .foregroundStyle(model.expiresSoon(target) ? .orange : .secondary)
            }
            Spacer()
            if model.running == target { ProgressView().controlSize(.small) }
            else if let ok = model.results[target] {
                Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(ok ? .green : .red).font(.title3)
            }
            Button("Installer") { model.install([target]) }.disabled(model.busy)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.06)))
    }
}

struct ContentView: View {
    @StateObject var model = Model()
    @State private var details = false
    let timer = Timer.publish(every: 8, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Mettre Espaces à jour").font(.title2.weight(.semibold))
            Text("Compile le projet et l'installe sur vos appareils. Ils gardent leurs données : seule l'app est remplacée.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

            ForEach(Target.allCases) { DeviceCard(model: model, target: $0) }

            HStack {
                if model.busy {
                    ProgressView().controlSize(.small)
                    Text(model.step).font(.callout).lineLimit(2)
                    Spacer()
                    Button("Arrêter") { model.cancel() }
                } else {
                    Spacer()
                    Button { model.install([.ipad, .iphone]) } label: {
                        Label("Installer sur l'iPad et l'iPhone", systemImage: "arrow.down.app").padding(.horizontal, 6)
                    }
                    .controlSize(.large)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                }
            }

            if let p = model.problem {
                Label(p, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            DisclosureGroup("Détails", isExpanded: $details) {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(model.log.isEmpty ? "Rien pour l'instant." : model.log)
                            .font(.system(size: 10.5, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("bas")
                    }
                    .frame(height: 160)
                    .onChange(of: model.log) { _ in proxy.scrollTo("bas", anchor: .bottom) }
                }
            }
            .font(.callout)

            HStack(spacing: 6) {
                Image(systemName: "folder").foregroundStyle(.secondary)
                Text(model.project).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Changer…") { model.chooseProject() }.controlSize(.small).disabled(model.busy)
            }
        }
        .padding(22)
        .frame(width: 520)
        .onAppear {
            model.refreshDevices()
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        .onReceive(timer) { _ in if !model.busy { model.refreshDevices() } }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ n: Notification) { UNUserNotificationCenter.current().delegate = self }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    // la notification s'affiche même quand l'Installeur est au premier plan
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
}

@main
struct InstalleurApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("Installeur Espaces") { ContentView() }
            .windowResizability(.contentSize)
    }
}
