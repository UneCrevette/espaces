// Espaces — hôte macOS : une fenêtre WebKit qui charge l'interface web
// et lui fournit le stockage, l'import d'images/PDF et l'export HTML.

import Cocoa
import WebKit
import PDFKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let voice = VoiceRecorder()
    var backedUp = false
    let saveQueue = DispatchQueue(label: "app.espaces.save", qos: .userInitiated)
    // un .espace ouvert avant que la page soit prête (double-clic qui lance l'app) attend ici
    var pageReady = false
    var pendingEspaces: [String] = []
    /// Le type de fichier .espace (déclaré dans Info.plist)
    static let espaceType = UTType("app.espaces.space") ?? UTType(filenameExtension: "espace") ?? .json

    lazy var supportDir: URL = {
        // ESPACES_DATA_DIR : une bibliothèque à part, pour essayer l'app sans toucher à la vraie
        let custom = ProcessInfo.processInfo.environment["ESPACES_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        let dir = custom ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Espaces", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    var libraryURL: URL { supportDir.appendingPathComponent("library.json") }
    var webDir: URL { Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        // la musique d'ambiance et les effets sont synthétisés en direct (Web Audio)
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Espaces"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.minSize = NSSize(width: 960, height: 640)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("EspacesMainWindow")
        window.makeKeyAndOrderFront(nil)

        webView.loadFileURL(webDir.appendingPathComponent("index.html"), allowingReadAccessTo: webDir)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { saveQueue.sync {} }   // une écriture en cours va à son terme

    // au retour dans l'app, on regarde si l'autre appareil a écrit entre-temps
    func applicationDidBecomeActive(_ notification: Notification) { checkSync() }

    // MARK: - Synchronisation (un dossier partagé, en général dans iCloud Drive)

    static let syncFileName = "Espaces-bibliotheque.json"
    var syncSeen: Date?
    var syncTimer: Timer?
    var syncWatch: DispatchSourceFileSystemObject?
    var peer: PeerLink?
    var sharePeer: PeerLink?

    var syncFolder: URL? {
        let env = ProcessInfo.processInfo.environment
        if let dir = env["ESPACES_SYNC_DIR"] { return URL(fileURLWithPath: dir, isDirectory: true) }
        // une bibliothèque d'essai ne se synchronise jamais avec le vrai iCloud
        if env["ESPACES_DATA_DIR"] != nil { return nil }
        return UserDefaults.standard.string(forKey: "syncFolder").map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
    var syncFileURL: URL? { syncFolder?.appendingPathComponent(Self.syncFileName) }

    func syncModDate() -> Date? {
        guard var url = syncFileURL else { return nil }
        url.removeAllCachedResourceValues()
        return try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    func startSyncWatch() {
        syncTimer?.invalidate()
        syncWatch?.cancel()
        guard let folder = syncFolder else { return }
        syncSeen = syncModDate()
        // averti dès qu'iCloud dépose une nouvelle version dans le dossier ; un coup d'œil régulier en filet de sécurité
        let fd = open(folder.path, O_EVTONLY)
        if fd >= 0 {
            let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .extend, .attrib], queue: .main)
            src.setEventHandler { [weak self] in self?.checkSync() }
            src.setCancelHandler { close(fd) }
            src.resume()
            syncWatch = src
        }
        syncTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.checkSync() }
    }

    /// Le lien direct : la page donne la clé partagée, et chaque copie reçue d'un autre appareil lui est transmise.
    func startPeer(key: String) {
        if let peer { peer.key = key; return }
        let link = PeerLink(key: key) { [weak self] text in
            guard let data = try? JSONSerialization.data(withJSONObject: [text]), let literal = String(data: data, encoding: .utf8) else { return }
            self?.webView?.evaluateJavaScript("window.__peerIncoming && window.__peerIncoming(\(literal)[0])", completionHandler: nil)
        }
        link.onJoin = { [weak self] in self?.webView?.evaluateJavaScript("window.__peerJoined && window.__peerJoined()", completionHandler: nil) }
        link.start()
        peer = link
    }

    /// La copie partagée a changé depuis la dernière fois qu'on l'a vue : la page relit et fusionne.
    func checkSync() {
        guard pageReady, let date = syncModDate() else { return }
        if let seen = syncSeen, date <= seen { return }
        syncSeen = date
        webView?.evaluateJavaScript("window.__syncChanged && window.__syncChanged()", completionHandler: nil)
    }

    /// Lecture et écriture coordonnées : iCloud peut être en train de télécharger ou d'envoyer le fichier.
    func shareFolder(_ ref: String?) -> URL? { ref.map { URL(fileURLWithPath: $0, isDirectory: true) } }

    /// Note partagée : un fichier par note, dans un dossier iCloud Drive que l'on partage avec quelqu'un d'autre
    func shareFile(_ d: [String: Any]) -> URL? {
        guard let folder = shareFolder(d["ref"] as? String), let file = d["file"] as? String, !file.contains("/") else { return nil }
        return folder.appendingPathComponent(file)
    }
    func shareReadText(_ url: URL) -> String? {
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        var text: String?
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &err) { text = try? String(contentsOf: $0, encoding: .utf8) }
        return text
    }
    func shareWriteText(_ text: String, to url: URL) throws {
        var err: NSError?
        var failure: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &err) {
            do { try text.write(to: $0, atomically: true, encoding: .utf8) } catch { failure = error }
        }
        if let e = failure ?? err { throw e }
    }
    func shareListFiles(_ ref: String?) -> [String] {
        guard let folder = shareFolder(ref) else { return [] }
        // (les fichiers encore dans le nuage portent un nom « .nom.icloud »)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.compactMap { n -> String? in
            if n.hasSuffix(".espnote") { return n }
            if n.hasPrefix("."), n.hasSuffix(".espnote.icloud") { try? FileManager.default.startDownloadingUbiquitousItem(at: folder.appendingPathComponent(n)); return String(n.dropFirst().dropLast(7)) }
            return nil
        }
    }

    func readSyncFile() -> String? {
        guard let url = syncFileURL else { return nil }
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        var text: String?
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &err) { text = try? String(contentsOf: $0, encoding: .utf8) }
        return text
    }

    func writeSyncFile(_ text: String) throws {
        guard let folder = syncFolder, let url = syncFileURL else { return }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var err: NSError?
        var failure: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &err) {
            do { try text.write(to: $0, atomically: true, encoding: .utf8) } catch { failure = error }
        }
        if let e = failure ?? err { throw e }
    }

    func syncStateReply() -> [String: Any] {
        ["enabled": syncFolder != nil, "folder": syncFolder?.lastPathComponent ?? ""]
    }

    // MARK: - Fichiers .espace

    /// Double-clic sur un .espace, ou dépôt sur l'icône : l'espace s'ouvre dans l'éditeur.
    func application(_ sender: NSApplication, open urls: [URL]) {
        for url in urls where url.pathExtension.lowercased() == "espace" {
            if let text = try? String(contentsOf: url, encoding: .utf8) { deliverEspace(text) }
        }
    }

    func deliverEspace(_ text: String) {
        guard pageReady, let webView else { pendingEspaces.append(text); return }
        // le texte passe en littéral JSON : aucun caractère ne peut casser le script
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let literal = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__openEspace && window.__openEspace(\(literal)[0])", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        startSyncWatch()
        let waiting = pendingEspaces
        pendingEspaces = []
        waiting.forEach(deliverEspace)
    }

    @objc func menuOpenEspace(_ sender: Any?) {
        webView?.evaluateJavaScript("window.__menu && window.__menu('open')", completionHandler: nil)
    }

    @objc func menuShareEspace(_ sender: Any?) {
        webView?.evaluateJavaScript("window.__menu && window.__menu('share')", completionHandler: nil)
    }

    // MARK: - Pont JavaScript

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "Message invalide")
            return
        }
        let payload = body["payload"]

        switch cmd {
        case "load":
            replyHandler(try? String(contentsOf: libraryURL, encoding: .utf8), nil)

        case "save":
            guard let json = payload as? String else { replyHandler(nil, "Données manquantes"); return }
            // écrire prend du temps quand la bibliothèque est lourde : jamais sur le fil de l'interface (et une écriture à la fois)
            saveQueue.async {
                do {
                    // une copie de sécurité de la bibliothèque par lancement
                    if !self.backedUp, FileManager.default.fileExists(atPath: self.libraryURL.path) {
                        let backup = self.supportDir.appendingPathComponent("library.backup.json")
                        try? FileManager.default.removeItem(at: backup)
                        try? FileManager.default.copyItem(at: self.libraryURL, to: backup)
                        self.backedUp = true
                    }
                    try json.write(to: self.libraryURL, atomically: true, encoding: .utf8)
                    DispatchQueue.main.async { replyHandler(true, nil) }
                } catch {
                    DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) }
                }
            }

        case "importPDF":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.pdf]
            panel.allowsMultipleSelection = true
            panel.message = "Choisissez un ou plusieurs PDF"
            panel.beginSheetModal(for: window) { response in
                guard response == .OK else { replyHandler([Any](), nil); return }
                let urls = panel.urls
                DispatchQueue.global(qos: .userInitiated).async {
                    let results = urls.compactMap { url -> [String: Any]? in
                        guard let doc = PDFDocument(url: url) else { return nil }
                        return Self.render(doc, name: url.deletingPathExtension().lastPathComponent)
                    }
                    DispatchQueue.main.async { replyHandler(results, nil) }
                }
            }

        case "pdfFromData":
            guard let p = payload as? [String: Any], let b64 = p["data"] as? String,
                  let data = Data(base64Encoded: b64) else { replyHandler(nil, "PDF invalide"); return }
            let name = p["name"] as? String ?? "Document"
            DispatchQueue.global(qos: .userInitiated).async {
                let result = PDFDocument(data: data).map { Self.render($0, name: name) }
                DispatchQueue.main.async {
                    if let result { replyHandler(result, nil) } else { replyHandler(nil, "PDF illisible") }
                }
            }

        case "pickImages":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.image]
            panel.allowsMultipleSelection = true
            panel.beginSheetModal(for: window) { response in
                guard response == .OK else { replyHandler([String](), nil); return }
                let urls = panel.urls
                DispatchQueue.global(qos: .userInitiated).async {
                    let srcs = urls.compactMap(Self.imageDataURL)
                    DispatchQueue.main.async { replyHandler(srcs, nil) }
                }
            }

        case "exportHTML":
            guard let p = payload as? [String: Any], let data = p["data"] as? String else {
                replyHandler(nil, "Données manquantes"); return
            }
            let name = (p["name"] as? String ?? "Espace")
                .components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.html]
            panel.nameFieldStringValue = name + ".html"
            panel.message = "Un seul fichier, lisible dans n'importe quel navigateur"
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { replyHandler(nil, nil); return }
                do {
                    try self.buildExport(data: data).write(to: url, atomically: true, encoding: .utf8)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                    replyHandler(url.lastPathComponent, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }

        case "exportEspace":
            guard let p = payload as? [String: Any], let data = p["data"] as? String else {
                replyHandler(nil, "Données manquantes"); return
            }
            let name = (p["name"] as? String ?? "Espace")
                .components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
            let panel = NSSavePanel()
            panel.allowedContentTypes = [Self.espaceType]
            panel.nameFieldStringValue = name + ".espace"
            panel.message = "Un fichier à ouvrir dans Espaces sur un autre ordinateur, avec tout son contenu"
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { replyHandler(nil, nil); return }
                do {
                    try data.write(to: url, atomically: true, encoding: .utf8)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                    replyHandler(url.lastPathComponent, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }

        case "openEspace":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [Self.espaceType]
            panel.allowsMultipleSelection = false
            panel.message = "Choisissez un espace reçu (.espace)"
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { replyHandler(nil, nil); return }
                replyHandler(try? String(contentsOf: url, encoding: .utf8), nil)
            }

        case "emojiPalette":
            // la palette de caractères du Mac insère l'émoji dans le champ qui a le focus
            NSApp.orderFrontCharacterPalette(nil)
            replyHandler(true, nil)

        case "readClipboard":
            // le menu contextuel colle sans passer par ⌘V : l'app lit elle-même le presse-papiers
            let pb = NSPasteboard.general
            replyHandler(["html": pb.string(forType: .html) ?? "", "text": pb.string(forType: .string) ?? ""], nil)

        case "writeClipboard":
            guard let d = payload as? [String: Any] else { replyHandler(nil, "Données manquantes"); return }
            let pb = NSPasteboard.general
            pb.clearContents()
            if let h = d["html"] as? String, !h.isEmpty { pb.setString(h, forType: .html) }
            pb.setString((d["text"] as? String) ?? "", forType: .string)
            replyHandler(true, nil)

        case "haptic":
            // retour haptique du trackpad Force Touch (senti seulement si le doigt est posé dessus)
            let kind = payload as? String
            let pattern: NSHapticFeedbackManager.FeedbackPattern = kind == "step" ? .levelChange : kind == "hover" || kind == "generic" ? .generic : .alignment
            NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
            replyHandler(true, nil)

        case "log":
            replyHandler(true, nil)

        case "voiceStart":
            voice.start { error in replyHandler(error == nil ? true : nil, error) }

        case "voiceLevel":
            voice.level { replyHandler($0, nil) }

        case "voiceStop":
            voice.stop(keep: payload as? Bool ?? true) { replyHandler($0, nil) }

        case "spellCheck":
            // une liste de paragraphes, une liste de fautes pour chacun
            let texts = payload as? [String] ?? []
            replyHandler(texts.map { Spell.check($0) }, nil)

        case "spellLearn":
            if let w = payload as? String { Spell.learn(w) }
            replyHandler(true, nil)

        case "inkMode":
            // (sur iPad, met Scribble en sourdine ; rien à faire sur Mac)
            replyHandler(true, nil)

        case "recognizeInk":
            // l'écriture d'une feuille devient du texte (reconnaissance d'Apple, sur l'appareil)
            guard let png = payload as? String else { replyHandler(nil, "Données manquantes"); return }
            InkText.recognize(pngBase64: png) { text, error in replyHandler(text, error) }

        case "exportPDF":
            guard let p = payload as? [String: Any], let html = p["html"] as? String else { replyHandler(nil, "Données manquantes"); return }
            let name = (p["name"] as? String ?? "Page") + ".pdf"
            chooseExportURL(name: name, type: .pdf) { url in
                guard let url else { replyHandler(nil, nil); return }
                let w = p["width"] as? Double, h = p["height"] as? Double
                self.renderPDF(html: html, to: url, slide: w != nil && h != nil ? CGSize(width: w!, height: h!) : nil) { error in
                    if let error { replyHandler(nil, error); return }
                    if ProcessInfo.processInfo.environment["ESPACES_EXPORT_DIR"] == nil { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    replyHandler(url.lastPathComponent, nil)
                }
            }

        case "saveFile":
            guard let p = payload as? [String: Any], let b64 = p["data"] as? String, let data = Data(base64Encoded: b64) else {
                replyHandler(nil, "Données manquantes"); return
            }
            let ext = p["ext"] as? String ?? "bin"
            chooseExportURL(name: (p["name"] as? String ?? "Page") + "." + ext, type: UTType(filenameExtension: ext) ?? .data) { url in
                guard let url else { replyHandler(nil, nil); return }
                do {
                    try data.write(to: url)
                    if ProcessInfo.processInfo.environment["ESPACES_EXPORT_DIR"] != nil {
                        // copie d'essai : rien ne s'ouvre
                    } else if p["open"] as? String == "pages", let pages = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iWork.Pages") {
                        NSWorkspace.shared.open([url], withApplicationAt: pages, configuration: NSWorkspace.OpenConfiguration())
                    } else {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    }
                    replyHandler(url.lastPathComponent, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }

        case "syncState":
            replyHandler(syncStateReply(), nil)

        case "syncSetup":
            if ProcessInfo.processInfo.environment["ESPACES_DATA_DIR"] != nil, ProcessInfo.processInfo.environment["ESPACES_SYNC_DIR"] == nil {
                replyHandler(nil, "Bibliothèque d'essai : synchronisation désactivée"); return
            }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Synchroniser ici"
            panel.message = "Choisissez (ou créez) un dossier dans iCloud Drive : vos espaces s'y synchroniseront avec vos autres appareils"
            let icloud = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
            if FileManager.default.fileExists(atPath: icloud.path) { panel.directoryURL = icloud }
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { replyHandler(["enabled": false], nil); return }
                UserDefaults.standard.set(url.path, forKey: "syncFolder")
                self.startSyncWatch()
                replyHandler(self.syncStateReply(), nil)
            }

        case "sharePick":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Choisir"
            panel.message = (payload as? String) ?? "Choisissez le dossier iCloud Drive partagé avec l'autre personne"
            let icloud = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
            if FileManager.default.fileExists(atPath: icloud.path) { panel.directoryURL = icloud }
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { replyHandler(nil, nil); return }
                replyHandler(["ref": url.path, "name": url.lastPathComponent], nil)
            }

        case "shareList":
            replyHandler(shareListFiles(payload as? String), nil)

        case "shareRead":
            guard let d = payload as? [String: Any], let url = shareFile(d) else { replyHandler(nil, "Dossier partagé introuvable"); return }
            DispatchQueue.global(qos: .userInitiated).async {
                let text = self.shareReadText(url)
                DispatchQueue.main.async { replyHandler(text, nil) }
            }

        case "shareWrite":
            guard let d = payload as? [String: Any], let url = shareFile(d), let text = d["text"] as? String else { replyHandler(nil, "Dossier partagé introuvable"); return }
            DispatchQueue.global(qos: .userInitiated).async {
                do { try self.shareWriteText(text, to: url); DispatchQueue.main.async { replyHandler(true, nil) } }
                catch { DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) } }
            }

        case "syncStop":
            UserDefaults.standard.removeObject(forKey: "syncFolder")
            syncTimer?.invalidate()
            syncWatch?.cancel()
            peer?.stop()
            peer = nil
            replyHandler(true, nil)

        case "peerStart":
            if let key = payload as? String, !key.isEmpty, syncFolder != nil { startPeer(key: key) }
            replyHandler(true, nil)

        case "sharePeerStart":
            // une note partagée ouverte : un lien direct avec l'autre personne, à proximité (la clé est celle de la note)
            sharePeer?.stop()
            sharePeer = nil
            if let key = payload as? String, !key.isEmpty {
                let link = PeerLink(key: key) { [weak self] text in
                    guard let data = try? JSONSerialization.data(withJSONObject: [text]), let literal = String(data: data, encoding: .utf8) else { return }
                    self?.webView?.evaluateJavaScript("window.__shareIncoming && window.__shareIncoming(\(literal)[0])", completionHandler: nil)
                }
                link.start()
                sharePeer = link
            }
            replyHandler(true, nil)

        case "sharePeerSend":
            if let text = payload as? String { sharePeer?.send(text) }
            replyHandler(true, nil)

        case "peerSend":
            if let text = payload as? String { peer?.send(text) }
            replyHandler(true, nil)

        case "syncRead":
            DispatchQueue.global(qos: .userInitiated).async {
                let text = self.readSyncFile()
                DispatchQueue.main.async { replyHandler(text, nil) }
            }

        case "syncWrite":
            guard let text = payload as? String else { replyHandler(nil, "Données manquantes"); return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try self.writeSyncFile(text)
                    DispatchQueue.main.async { self.syncSeen = self.syncModDate(); replyHandler(true, nil) }
                } catch {
                    DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) }
                }
            }

        case "openURL":
            if let s = payload as? String, let url = URL(string: s), url.scheme != "file" {
                NSWorkspace.shared.open(url)
            }
            replyHandler(true, nil)

        default:
            replyHandler(nil, "Commande inconnue : \(cmd)")
        }
    }

    // MARK: - PDF et images

    /// Chaque page devient une image JPEG : la mise en page d'origine est conservée,
    /// y compris dans un espace exporté.
    static func render(_ doc: PDFDocument, name: String) -> [String: Any] {
        var pages: [String] = []
        for i in 0..<min(doc.pageCount, 120) {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .cropBox)
            let scale = 1400 / max(box.width, 1)
            let image = page.thumbnail(of: NSSize(width: box.width * scale, height: box.height * scale), for: .cropBox)
            if let jpeg = jpegData(image, quality: 0.82) {
                pages.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
            }
        }
        return ["name": name, "pages": pages, "text": String((doc.string ?? "").prefix(4000))]
    }

    static func jpegData(_ image: NSImage, quality: Double) -> Data? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: quality])
    }

    static func imageDataURL(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let ext = url.pathExtension.lowercased()
        let webTypes = ["jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"]
        if let mime = webTypes[ext], ext == "gif" || data.count < 1_500_000 {
            return "data:\(mime);base64," + data.base64EncodedString()
        }
        // trop lourde ou format non web (HEIC, TIFF…) : on réduit et convertit
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 2400,
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        if ext == "png", let png = rep.representation(using: .png, properties: [:]) {
            return "data:image/png;base64," + png.base64EncodedString()
        }
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.86]) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    // MARK: - Exporter la page (PDF, Word)

    /// Où enregistrer : le choix de l'utilisateur, ou (copie d'essai) directement un dossier donné
    func chooseExportURL(name: String, type: UTType, done: @escaping (URL?) -> Void) {
        let safe = name.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
        if let dir = ProcessInfo.processInfo.environment["ESPACES_EXPORT_DIR"] {
            done(URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent(safe)); return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [type]
        panel.nameFieldStringValue = safe
        panel.beginSheetModal(for: window) { done($0 == .OK ? panel.url : nil) }
    }

    var pdfJob: PagePDF?
    /// Une fenêtre hors de l'écran : WebKit ne met en page qu'une vue rattachée à une fenêtre
    lazy var offscreen: NSWindow = {
        let w = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 600, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.orderBack(nil)
        return w
    }()

    /// La page, mise en forme puis découpée en pages A4 (voir PagePDF)
    func renderPDF(html: String, to url: URL, slide: CGSize? = nil, done: @escaping (String?) -> Void) {
        pdfJob = PagePDF(html: html, base: webDir, slide: slide, host: { self.offscreen.contentView?.addSubview($0) }) { [weak self] data, error in
            self?.pdfJob = nil
            guard let data else { done(error ?? "PDF impossible"); return }
            do { try data.write(to: url); done(nil) } catch { done(error.localizedDescription) }
        }
    }

    // MARK: - Export HTML autonome

    /// Un seul fichier : interface, styles et contenu de l'espace en ligne.
    func buildExport(data: String) throws -> String {
        var html = try String(contentsOf: webDir.appendingPathComponent("index.html"), encoding: .utf8)
        let css = try String(contentsOf: webDir.appendingPathComponent("styles.css"), encoding: .utf8)
        // le code est recopié dans la page : un « </script> » écrit dans ses textes y fermerait la balise trop tôt, et la
        // page n'afficherait que du texte brut. « <\/script> » se lit pareil en JavaScript, mais plus comme une balise.
        let js = try String(contentsOf: webDir.appendingPathComponent("app.js"), encoding: .utf8)
            .replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        let safeData = data.replacingOccurrences(of: "</", with: "<\\/")
        html = html.replacingOccurrences(of: "<link rel=\"stylesheet\" href=\"styles.css\">",
                                         with: "<style>\n\(css)\n</style>")
        html = html.replacingOccurrences(of: "<script src=\"app.js\"></script>",
                                         with: "<script>window.__EXPORT__ = \(safeData);</script>\n<script>\n\(js)\n</script>")
        // le fichier exporté vit seul : sans l'icône ni le manifeste de la version web, qui ne sont pas à côté de lui
        let alone = ["rel=\"manifest\"", "rel=\"icon\"", "rel=\"apple-touch-icon\""]
        return html.components(separatedBy: "\n").filter { line in !alone.contains { line.hasPrefix("<link") && line.contains($0) } }.joined(separator: "\n")
    }

    // MARK: - Navigation : les liens externes s'ouvrent dans le navigateur

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme != "file", url.scheme != "about", url.scheme != "data", url.scheme != "blob" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - Menus (nécessaires pour ⌘C, ⌘V, ⌘Z… dans la vue web)

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "À propos d’Espaces", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Masquer Espaces", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Masquer les autres", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quitter Espaces", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: appMenu, title: "Espaces")

        let file = NSMenu(title: "Fichier")
        let open = file.addItem(withTitle: "Ouvrir un .espace…", action: #selector(menuOpenEspace(_:)), keyEquivalent: "o")
        open.target = self
        let share = file.addItem(withTitle: "Partager l’espace (.espace)…", action: #selector(menuShareEspace(_:)), keyEquivalent: "e")
        share.keyEquivalentModifierMask = [.command, .shift]
        share.target = self
        main.addItem(submenu: file, title: "Fichier")

        let edit = NSMenu(title: "Édition")
        edit.addItem(withTitle: "Annuler", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Rétablir", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Couper", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copier", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Coller", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let plain = edit.addItem(withTitle: "Coller sans mise en forme", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        plain.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Tout sélectionner", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "Édition")

        let viewMenu = NSMenu(title: "Présentation")
        let full = viewMenu.addItem(withTitle: "Plein écran", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu: viewMenu, title: "Présentation")

        let win = NSMenu(title: "Fenêtre")
        win.addItem(withTitle: "Réduire", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Fermer", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu: win, title: "Fenêtre")
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        addItem(item)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

