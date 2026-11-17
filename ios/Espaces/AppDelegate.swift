// Espaces — hôte iPad : la même interface web que sur Mac, dans une vue WebKit plein écran,
// avec le stockage, l'import d'images/PDF, l'export et la synchronisation par un dossier iCloud Drive.

import UIKit
import os
import AVFoundation
import WebKit
import PDFKit
import PhotosUI
import UniformTypeIdentifiers

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    let host = WebHostController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.backgroundColor = .white
        window.makeKeyAndVisible()
        self.window = window
        activateAudio()
        return true
    }

    /// La musique et les bruitages d'Espaces jouent même si l'iPad est en mode silencieux, et se mêlent à ce qui joue déjà
    /// (par défaut, le son d'une page web se tait en mode silencieux)
    func activateAudio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    /// Un .espace ouvert depuis l'app Fichiers, ou partagé vers Espaces.
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.pathExtension.lowercased() == "espace" else { return false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let text = try? String(contentsOf: url, encoding: .utf8) { host.deliverEspace(text) }
        return true
    }

    // au retour dans l'app, on regarde si l'autre appareil a écrit entre-temps, et on retrouve les appareils proches
    func applicationDidBecomeActive(_ application: UIApplication) {
        host.peer?.restart()
        host.checkSync()
    }
}

final class WebHostController: UIViewController, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate,
                               UIDocumentPickerDelegate, PHPickerViewControllerDelegate, NSFilePresenter {
    var webView: WKWebView!
    var backedUp = false
    let saveQueue = DispatchQueue(label: "app.espaces.save", qos: .userInitiated)
    var pageReady = false
    var webBottom: NSLayoutConstraint!
    var pageLock: NSKeyValueObservation?
    /// Scribble (l'écriture convertie en texte) se tait tant qu'une feuille manuscrite est ouverte
    let scribbleGate = ScribbleGate()
    let voice = VoiceRecorder()
    let places = PlaceFinder()
    let photos = PhotoTaker()
    var pendingEspaces: [String] = []
    /// Le sélecteur ouvert en ce moment, et ce qu'il faut faire de son résultat
    var pickerDone: (([URL]) -> Void)?
    var photosDone: (([String]) -> Void)?
    static let espaceType = UTType("app.espaces.space") ?? UTType(filenameExtension: "espace") ?? .json

    lazy var supportDir: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    var libraryURL: URL { supportDir.appendingPathComponent("library.json") }
    var webDir: URL { Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true) }

    override var prefersStatusBarHidden: Bool { UIDevice.current.userInterfaceIdiom != .phone }
    // sur iPhone, l'app se tient droite
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { UIDevice.current.userInterfaceIdiom == .phone ? .portrait : .all }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        // l'interface sait qu'elle tourne sur iPad (gestes tactiles, pas de survol)
        config.userContentController.addUserScript(WKUserScript(source: "window.__PLATFORM = '\(UIDevice.current.userInterfaceIdiom == .phone ? "iphone" : "ipad")';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // une musique (Spotify, Deezer…) ou un appel en cours au lancement : la page le sait avant de faire le moindre son
        config.userContentController.addUserScript(WKUserScript(source: "window.__OTHER_AUDIO = \(Self.otherAudio)", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        webView = EspacesWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .white
        // la page tient l'écran : pas de rebond ni de défilement de la page entière (les zones intérieures défilent)
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        // la page occupe l'écran jusqu'au clavier : elle se raccourcit avec lui, iOS n'a plus rien à remonter
        let root = UIView()
        root.backgroundColor = .white
        webView.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(webView)
        webBottom = webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webBottom
        ])
        view = root
        // et si iOS tente quand même de faire défiler la page entière, elle reste en place
        pageLock = webView.scrollView.observe(\.contentOffset) { sv, _ in
            if sv.contentOffset != .zero { sv.contentOffset = .zero }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(otherAudioChanged), name: AVAudioSession.silenceSecondaryAudioHintNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    /// Le clavier s'ouvre, se ferme ou change de taille : le bas de la page le suit, au même rythme
    @objc func keyboardMoved(_ note: Notification) {
        guard let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        webBottom.constant = -overlap
        let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        UIView.animate(withDuration: duration, delay: 0, options: UIView.AnimationOptions(rawValue: curve << 16)) { self.view.layoutIfNeeded() }
    }

    /// Une autre app joue du son, ou un appel est en cours
    static var otherAudio: Bool {
        let s = AVAudioSession.sharedInstance()
        return s.isOtherAudioPlaying || s.secondaryAudioShouldBeSilencedHint
    }
    @objc func otherAudioChanged() {
        webView.evaluateJavaScript("window.__otherAudio && window.__otherAudio(\(Self.otherAudio))")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        diagLog("APP LANCÉE")
        // l'Apple Pencil : double-toucher et pression (Pencil Pro) ; Scribble peut être mis en sourdine
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        webView.addInteraction(pencil)
        webView.addInteraction(UIScribbleInteraction(delegate: scribbleGate))
        resolveSyncFolder()
        webView.loadFileURL(webDir.appendingPathComponent("index.html"), allowingReadAccessTo: webDir)
    }

    // MARK: - Fichiers .espace

    func deliverEspace(_ text: String) {
        guard pageReady else { pendingEspaces.append(text); return }
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let literal = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__openEspace && window.__openEspace(\(literal)[0])", completionHandler: nil)
    }

    /// Scribble passe par la vue intérieure de la page (celle qui reçoit le texte) : la sourdine s'y pose aussi
    func gateScribbleInContent() {
        func walk(_ v: UIView) {
            if NSStringFromClass(type(of: v)).contains("WKContentView"), !v.interactions.contains(where: { $0 is UIScribbleInteraction }) {
                v.addInteraction(UIScribbleInteraction(delegate: scribbleGate))
            }
            v.subviews.forEach(walk)
        }
        walk(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        gateScribbleInContent()
        pageReady = true
        startSyncWatch()
        let waiting = pendingEspaces
        pendingEspaces = []
        waiting.forEach(deliverEspace)
    }

    // MARK: - Sélecteurs de fichiers et de photos

    func pickFiles(_ types: [UTType], multiple: Bool, done: @escaping ([URL]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = multiple
        picker.delegate = self
        pickerDone = done
        present(picker, animated: true)
    }

    /// Enregistrer un fichier préparé : l'utilisateur choisit où (Fichiers, iCloud Drive…)
    func exportFile(_ url: URL, done: @escaping (Bool) -> Void) {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = self
        pickerDone = { done(!$0.isEmpty) }
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let done = pickerDone
        pickerDone = nil
        done?(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let done = pickerDone
        pickerDone = nil
        done?([])
    }

    func pickPhotos(done: @escaping ([String]) -> Void) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 0
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        photosDone = done
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let done = photosDone
        photosDone = nil
        guard !results.isEmpty else { done?([]); return }
        var srcs = [String?](repeating: nil, count: results.count)
        let group = DispatchGroup()
        for (i, result) in results.enumerated() {
            group.enter()
            result.itemProvider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                if let data { srcs[i] = Self.imageDataURL(data, ext: "") }
                group.leave()
            }
        }
        group.notify(queue: .main) { done?(srcs.compactMap { $0 }) }
    }

    var pdfJob: PagePDF?
    func safeName(_ name: String) -> String { name.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-") }

    func tempFile(named name: String, ext: String, contents: String) throws -> URL {
        let safe = name.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe + "." + ext)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
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
        case "chunk":
            guard let d = payload as? [String: Any], let i = d["i"] as? Int, let part = (d["s"] as? String)?.data(using: .utf8) else { replyHandler(nil, "Données manquantes"); return }
            if i == 0 { try? FileManager.default.removeItem(at: chunkURL); FileManager.default.createFile(atPath: chunkURL.path, contents: nil) }
            guard let h = try? FileHandle(forWritingTo: chunkURL) else { replyHandler(nil, "Écriture impossible"); return }
            h.seekToEndOfFile(); h.write(part); try? h.close()
            replyHandler(true, nil)

        case "diag":
            diagLog("\(payload ?? "")")
            replyHandler(true, nil)

        case "load":
            var text = try? String(contentsOf: libraryURL, encoding: .utf8)
            if phone, let t = text, t.contains("\"history\":") { text = versionsQueue.sync { stashVersions(t) } }
            replyHandler(text, nil)

        case "versionsGet":
            guard let id = payload as? String else { replyHandler(nil, nil); return }
            versionsQueue.async {
                let h = self.storedVersions(id)
                let text = h.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .withoutEscapingSlashes) }.flatMap { String(data: $0, encoding: .utf8) }
                DispatchQueue.main.async { replyHandler(text, nil) }
            }

        case "versionsPut":
            guard let text = (payload as? String) ?? takeChunks(), let data = text.data(using: .utf8),
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = o["id"] as? String, let h = o["history"] as? [String: Any] else { replyHandler(nil, "Données manquantes"); return }
            versionsQueue.async {
                // les « gardée » de la page font foi : elle vient de les régler
                self.storeVersions(id, Self.joinHistory(self.storedVersions(id), h, keepFromB: true))
                DispatchQueue.main.async { replyHandler(true, nil) }
            }

        case "save":
            guard let json = (payload as? String) ?? takeChunks() else { replyHandler(nil, "Données manquantes"); return }
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
            pickFiles([.pdf], multiple: true) { urls in
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
            pickPhotos { replyHandler($0, nil) }

        case "exportHTML":
            guard let p = payload as? [String: Any], let data = p["data"] as? String else {
                replyHandler(nil, "Données manquantes"); return
            }
            do {
                let url = try tempFile(named: p["name"] as? String ?? "Espace", ext: "html", contents: try buildExport(data: data))
                exportFile(url) { ok in replyHandler(ok ? url.lastPathComponent : nil, nil) }
            } catch {
                replyHandler(nil, error.localizedDescription)
            }

        case "exportEspace":
            guard let p = payload as? [String: Any], let data = p["data"] as? String else {
                replyHandler(nil, "Données manquantes"); return
            }
            do {
                let url = try tempFile(named: p["name"] as? String ?? "Espace", ext: "espace", contents: data)
                exportFile(url) { ok in replyHandler(ok ? url.lastPathComponent : nil, nil) }
            } catch {
                replyHandler(nil, error.localizedDescription)
            }

        case "openEspace":
            pickFiles([Self.espaceType], multiple: false) { urls in
                replyHandler(urls.first.flatMap { try? String(contentsOf: $0, encoding: .utf8) }, nil)
            }

        case "emojiPalette":
            // sur iPad, les émojis sont sur le clavier
            replyHandler(false, nil)

        case "readClipboard":
            let pb = UIPasteboard.general
            let html = pb.data(forPasteboardType: UTType.html.identifier).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            replyHandler(["html": html, "text": pb.string ?? ""], nil)

        case "writeClipboard":
            guard let d = payload as? [String: Any] else { replyHandler(nil, "Données manquantes"); return }
            var item: [String: Any] = [UTType.utf8PlainText.identifier: (d["text"] as? String) ?? ""]
            if let h = d["html"] as? String, !h.isEmpty { item[UTType.html.identifier] = h }
            UIPasteboard.general.items = [item]
            replyHandler(true, nil)

        case "haptic":
            // l'iPad n'a pas de moteur haptique ; l'iPhone donne un petit choc aux moments francs
            if UIDevice.current.userInterfaceIdiom == .phone, payload as? String == "step" { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
            replyHandler(true, nil)

        case "log":
            // le journal du son : quelques lignes datées dans Documents/espaces-son.log (gardé court)
            guard let line = payload as? String else { replyHandler(true, nil); return }
            let url = supportDir.appendingPathComponent("espaces-son.log")
            var text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            text += line + "\n"
            if text.count > 60_000 { text = String(text.suffix(40_000)) }
            try? text.write(to: url, atomically: true, encoding: .utf8)
            replyHandler(true, nil)

        case "otherAudio":
            replyHandler(Self.otherAudio, nil)

        case "voiceStart":
            voice.start { error in replyHandler(error == nil ? true : nil, error) }

        case "voiceLevel":
            voice.level { replyHandler($0, nil) }

        case "voiceStop":
            voice.stop(keep: payload as? Bool ?? true) { replyHandler($0, nil) }

        case "takePhoto":
            photos.take(from: self) { url in replyHandler(url, nil) }

        case "whereAmI":
            places.find { place in replyHandler(place, nil) }

        case "spellCheck":
            // une liste de paragraphes, une liste de fautes pour chacun
            let texts = payload as? [String] ?? []
            replyHandler(texts.map { Spell.check($0) }, nil)

        case "spellLearn":
            if let w = payload as? String { Spell.learn(w) }
            replyHandler(true, nil)

        case "inkMode":
            // une feuille manuscrite s'ouvre (ou se ferme) : Scribble ne doit pas transformer l'écriture en texte
            scribbleGate.blocked = payload as? Bool ?? false
            replyHandler(true, nil)

        case "recognizeInk":
            // l'écriture d'une feuille devient du texte (reconnaissance d'Apple, sur l'appareil)
            guard let png = payload as? String else { replyHandler(nil, "Données manquantes"); return }
            InkText.recognize(pngBase64: png) { text, error in replyHandler(text, error) }

        case "exportPDF":
            guard let p = payload as? [String: Any], let html = p["html"] as? String else { replyHandler(nil, "Données manquantes"); return }
            let name = p["name"] as? String ?? "Page"
            let w = p["width"] as? Double, h = p["height"] as? Double
            pdfJob = PagePDF(html: html, base: webDir, slide: w != nil && h != nil ? CGSize(width: w!, height: h!) : nil, host: { v in
                // WebKit ne met en page qu'une vue rattachée à l'écran : elle est posée, invisible, derrière la page
                v.alpha = 0.01
                self.view.insertSubview(v, at: 0)
            }) { [weak self] data, error in
                guard let self else { return }
                self.pdfJob = nil
                guard let data else { replyHandler(nil, error ?? "PDF impossible"); return }
                do {
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(self.safeName(name) + ".pdf")
                    try data.write(to: url)
                    self.exportFile(url) { ok in replyHandler(ok ? url.lastPathComponent : nil, nil) }
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }

        case "saveFile":
            guard let p = payload as? [String: Any], let b64 = p["data"] as? String, let data = Data(base64Encoded: b64) else {
                replyHandler(nil, "Données manquantes"); return
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName(p["name"] as? String ?? "Page") + "." + (p["ext"] as? String ?? "bin"))
            do { try data.write(to: url) } catch { replyHandler(nil, error.localizedDescription); return }
            if p["open"] as? String == "pages" {
                // la feuille de partage : on y choisit Pages (qui importe le document Word)
                let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                share.popoverPresentationController?.sourceView = view
                share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 60, width: 1, height: 1)
                share.completionWithItemsHandler = { _, done, _, _ in replyHandler(done ? url.lastPathComponent : nil, nil) }
                present(share, animated: true)
            } else {
                exportFile(url) { ok in replyHandler(ok ? url.lastPathComponent : nil, nil) }
            }

        case "syncState":
            replyHandler(syncStateReply(), nil)

        case "syncSetup":
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.directoryURL = nil
            pickerDone = { urls in
                guard let url = urls.first else { replyHandler(["enabled": false], nil); return }
                self.adoptSyncFolder(url)
                replyHandler(self.syncStateReply(), nil)
            }
            present(picker, animated: true)

        case "sharePick":
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            pickerDone = { urls in
                guard let url = urls.first else { replyHandler(nil, nil); return }
                _ = url.startAccessingSecurityScopedResource()
                guard let data = try? url.bookmarkData() else { replyHandler(nil, "Dossier inaccessible"); return }
                replyHandler(["ref": data.base64EncodedString(), "name": url.lastPathComponent], nil)
            }
            present(picker, animated: true)

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
            NSFileCoordinator.removeFilePresenter(self)
            syncFolder?.stopAccessingSecurityScopedResource()
            syncFolder = nil
            UserDefaults.standard.removeObject(forKey: "syncBookmark")
            syncTimer?.invalidate()
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
                    self?.webView.evaluateJavaScript("window.__shareIncoming && window.__shareIncoming(\(literal)[0])", completionHandler: nil)
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

        case "syncStamp":
            replyHandler(syncModDate().map { String($0.timeIntervalSince1970) }, nil)

        case "syncRead":
            DispatchQueue.global(qos: .userInitiated).async {
                var text = self.readSyncFile()
                if self.phone, let t = text { text = self.versionsQueue.sync { self.stashVersions(t) } }
                DispatchQueue.main.async { replyHandler(text, nil) }
            }

        case "syncWrite":
            guard let text = (payload as? String) ?? takeChunks() else { replyHandler(nil, "Données manquantes"); return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try self.writeSyncFile(self.phone ? self.versionsQueue.sync { self.attachVersions(text) } : text)
                    DispatchQueue.main.async { self.syncSeen = self.syncModDate(); replyHandler(true, nil) }
                } catch {
                    DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) }
                }
            }

        case "openURL":
            if let s = payload as? String, let url = URL(string: s), url.scheme != "file" {
                UIApplication.shared.open(url)
            }
            replyHandler(true, nil)

        default:
            replyHandler(nil, "Commande inconnue : \(cmd)")
        }
    }

    // MARK: - Synchronisation (un dossier choisi une fois, en général dans iCloud Drive)

    static let syncFileName = "Espaces-bibliotheque.json"
    var syncFolder: URL?
    var syncSeen: Date?
    var syncTimer: Timer?
    var peer: PeerLink?
    var sharePeer: PeerLink?

    // NSFilePresenter : iCloud prévient quand il remplace le fichier partagé par une version venue d'ailleurs
    var presentedItemURL: URL? { syncFileURL }
    lazy var presentedItemOperationQueue: OperationQueue = .main
    func presentedItemDidChange() { checkSync() }
    var syncFileURL: URL? { syncFolder?.appendingPathComponent(Self.syncFileName) }

    /// L'iPad ne garde l'accès au dossier qu'à travers un signet : on le relit à chaque lancement.
    func resolveSyncFolder() {
        guard let data = UserDefaults.standard.data(forKey: "syncBookmark") else { return }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) else { return }
        _ = url.startAccessingSecurityScopedResource()
        syncFolder = url
        if stale, let fresh = try? url.bookmarkData() { UserDefaults.standard.set(fresh, forKey: "syncBookmark") }
    }

    func adoptSyncFolder(_ url: URL) {
        syncFolder?.stopAccessingSecurityScopedResource()
        _ = url.startAccessingSecurityScopedResource()
        if let data = try? url.bookmarkData() { UserDefaults.standard.set(data, forKey: "syncBookmark") }
        syncFolder = url
        startSyncWatch()
    }

    func syncModDate() -> Date? {
        guard var url = syncFileURL else { return nil }
        url.removeAllCachedResourceValues()
        return try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    func startSyncWatch() {
        syncTimer?.invalidate()
        NSFileCoordinator.removeFilePresenter(self)
        guard syncFolder != nil else { return }
        syncSeen = syncModDate()
        NSFileCoordinator.addFilePresenter(self)
        syncTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.checkSync() }
    }

    /// Le lien direct : la page donne la clé partagée, et chaque copie reçue d'un autre appareil lui est transmise.
    func startPeer(key: String) {
        if let peer { peer.key = key; return }
        let link = PeerLink(key: key) { [weak self] text in
            guard let data = try? JSONSerialization.data(withJSONObject: [text]), let literal = String(data: data, encoding: .utf8) else { return }
            self?.webView.evaluateJavaScript("window.__peerIncoming && window.__peerIncoming(\(literal)[0])", completionHandler: nil)
        }
        link.onJoin = { [weak self] in self?.webView.evaluateJavaScript("window.__peerJoined && window.__peerJoined()", completionHandler: nil) }
        link.start()
        peer = link
    }

    /// La copie partagée a changé depuis la dernière fois qu'on l'a vue : la page relit et fusionne.
    func checkSync() {
        guard pageReady, syncFolder != nil else { return }
        if let url = syncFileURL { try? FileManager.default.startDownloadingUbiquitousItem(at: url) }
        guard let date = syncModDate() else { return }
        if let seen = syncSeen, date <= seen { return }
        syncSeen = date
        webView.evaluateJavaScript("window.__syncChanged && window.__syncChanged()", completionHandler: nil)
    }

    /// (sur iPad et iPhone, le dossier choisi se retrouve par un signet, et s'ouvre le temps de l'accès)
    var shareFolders: [String: URL] = [:]
    func shareFolder(_ ref: String?) -> URL? {
        guard let ref = ref else { return nil }
        if let u = shareFolders[ref] { return u }
        guard let data = Data(base64Encoded: ref) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) else { return nil }
        _ = url.startAccessingSecurityScopedResource()
        shareFolders[ref] = url
        return url
    }

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
        guard let url = syncFileURL else { return }
        var err: NSError?
        var failure: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &err) {
            do { try text.write(to: $0, atomically: true, encoding: .utf8) } catch { failure = error }
        }
        if let e = failure ?? err { throw e }
    }

    /*
     * Sur iPhone, l'historique des versions (l'essentiel du poids de la bibliothèque) ne tient pas dans la page :
     * l'app le range à part, un fichier par carte, et la page ne demande que celui de la carte ouverte.
     * À la lecture du fichier partagé, ses versions rejoignent ce rangement ; à l'écriture, chaque carte y reprend
     * les siennes. Les mêmes versions partout, comme sur le Mac et l'iPad (une version se reconnaît à son heure).
     */
    static let versionMax = 40   // comme VERSION_MAX dans la page
    var phone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    let versionsQueue = DispatchQueue(label: "app.espaces.versions", qos: .userInitiated)
    lazy var versionsDir: URL = {
        let d = supportDir.appendingPathComponent("versions", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private func versionsURL(_ id: String) -> URL {
        let safe = String(id.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" ? Character($0) : "_" })
        return versionsDir.appendingPathComponent(safe + ".json")
    }
    func storedVersions(_ id: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: versionsURL(id)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    func storeVersions(_ id: String, _ h: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: h, options: .withoutEscapingSlashes) { try? data.write(to: versionsURL(id), options: .atomic) }
    }

    // les versions d'une bibliothèque rejoignent le rangement ; le texte rendu n'en contient plus
    func stashVersions(_ text: String) -> String {
        autoreleasepool {
            mapDocs(text) { d in
                guard let h = d.removeValue(forKey: "history") as? [String: Any], let id = d["id"] as? String else { return }
                storeVersions(id, Self.joinHistory(storedVersions(id), h))
            }
        }
    }

    // ce que l'iPhone écrit dans le fichier partagé : chaque carte avec toutes ses versions (celles du fichier comprises)
    func attachVersions(_ text: String) -> String {
        autoreleasepool {
            if let old = readSyncFile() { _ = stashVersions(old) }
            return mapDocs(text) { d in
                guard let id = d["id"] as? String else { return }
                if let mine = d["history"] as? [String: Any] { storeVersions(id, Self.joinHistory(storedVersions(id), mine)) }
                if let h = storedVersions(id) { d["history"] = h }
            }
        }
    }

    private func mapDocs(_ text: String, _ f: (inout [String: Any]) -> Void) -> String {
        guard let data = text.data(using: .utf8),
              var lib = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let spaces = lib["spaces"] as? [[String: Any]] else { return text }
        lib["spaces"] = spaces.map { sp -> [String: Any] in
            var sp = sp
            if let docs = sp["docs"] as? [[String: Any]] { sp["docs"] = docs.map { d -> [String: Any] in var d = d; f(&d); return d } }
            return sp
        }
        guard let out = try? JSONSerialization.data(withJSONObject: lib, options: .withoutEscapingSlashes) else { return text }
        return String(data: out, encoding: .utf8) ?? text
    }

    // deux historiques d'une même carte n'en font qu'un ; une version gardée d'un côté l'est des deux,
    // sauf keepFromB : b vient d'être réglé à la main, ses « gardée » font foi
    static func joinHistory(_ a: [String: Any]?, _ b: [String: Any], keepFromB: Bool = false) -> [String: Any] {
        guard let a else { return b }
        let stamp = { (v: [String: Any]) in (v["t"] as? NSNumber)?.int64Value ?? 0 }
        var byTime = [Int64: [String: Any]]()
        for v in (a["list"] as? [[String: Any]]) ?? [] { byTime[stamp(v)] = v }
        for v in (b["list"] as? [[String: Any]]) ?? [] {
            let t = stamp(v)
            if var was = byTime[t] {
                if keepFromB { was["keep"] = v["keep"] } else if (v["keep"] as? Bool) == true { was["keep"] = true }
                byTime[t] = was
            } else { byTime[t] = v }
        }
        var list = byTime.keys.sorted().map { byTime[$0]! }
        // au-delà du maximum, les plus anciennes s'en vont (sauf celles que l'auteur a gardées)
        while list.count > versionMax, let k = list.firstIndex(where: { ($0["keep"] as? Bool) != true }) { list.remove(at: k) }
        var pool = (a["pool"] as? [String: Any]) ?? [:]
        for (k, v) in (b["pool"] as? [String: Any]) ?? [:] { pool[k] = v }
        // les images que plus aucune version n'utilise ne sont pas gardées
        var used = Set<String>()
        let re = try! NSRegularExpression(pattern: "src=\"vimg:([a-z0-9]+)\"")
        for v in list { if let html = v["html"] as? String {
            for m in re.matches(in: html, range: NSRange(html.startIndex..., in: html)) { if let r = Range(m.range(at: 1), in: html) { used.insert(String(html[r])) } }
        } }
        pool = pool.filter { used.contains($0.key) }
        var out = a
        for (k, v) in b where k != "list" && k != "pool" { out[k] = v }
        out["list"] = list
        out["pool"] = pool
        return out
    }

    func syncStateReply() -> [String: Any] {
        ["enabled": syncFolder != nil, "folder": syncFolder?.lastPathComponent ?? ""]
    }

    // MARK: - PDF et images

    /// Chaque page devient une image JPEG : la mise en page d'origine est conservée.
    static func render(_ doc: PDFDocument, name: String) -> [String: Any] {
        var pages: [String] = []
        for i in 0..<min(doc.pageCount, 120) {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .cropBox)
            let scale = 1400 / max(box.width, 1)
            let image = page.thumbnail(of: CGSize(width: box.width * scale, height: box.height * scale), for: .cropBox)
            if let jpeg = image.jpegData(compressionQuality: 0.82) {
                pages.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
            }
        }
        return ["name": name, "pages": pages, "text": String((doc.string ?? "").prefix(4000))]
    }

    /// Une photo devient une image web : telle quelle si elle est légère et lisible partout, sinon réduite en JPEG.
    static func imageDataURL(_ data: Data, ext: String) -> String? {
        let header = [UInt8](data.prefix(4))
        let isPNG = header.starts(with: [0x89, 0x50, 0x4E, 0x47]), isJPEG = header.starts(with: [0xFF, 0xD8])
        if (isPNG || isJPEG), data.count < 1_500_000 {
            return "data:image/\(isPNG ? "png" : "jpeg");base64," + data.base64EncodedString()
        }
        // trop lourde ou format non web (HEIC des photos de l'iPad) : on réduit et convertit
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 2400,
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cg)
        if isPNG, let png = image.pngData() { return "data:image/png;base64," + png.base64EncodedString() }
        guard let jpeg = image.jpegData(compressionQuality: 0.86) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    // MARK: - Export HTML autonome

    /// Un seul fichier : interface, styles et contenu de l'espace en ligne.
    func buildExport(data: String) throws -> String {
        var html = try String(contentsOf: webDir.appendingPathComponent("index.html"), encoding: .utf8)
        let css = try String(contentsOf: webDir.appendingPathComponent("styles.css"), encoding: .utf8)
        let js = try String(contentsOf: webDir.appendingPathComponent("app.js"), encoding: .utf8)
        let safeData = data.replacingOccurrences(of: "</", with: "<\\/")
        html = html.replacingOccurrences(of: "<link rel=\"stylesheet\" href=\"styles.css\">",
                                         with: "<style>\n\(css)\n</style>")
        html = html.replacingOccurrences(of: "<script src=\"app.js\"></script>",
                                         with: "<script>window.__EXPORT__ = \(safeData);</script>\n<script>\n\(js)\n</script>")
        return html
    }

    // MARK: - Navigation : les liens externes s'ouvrent dans Safari

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme != "file", url.scheme != "about", url.scheme != "data", url.scheme != "blob" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    /// Le texte reçu par morceaux, reconstitué pour l'enregistrement
    var chunkURL: URL { FileManager.default.temporaryDirectory.appendingPathComponent("espaces-envoi.json") }
    func takeChunks() -> String? {
        defer { try? FileManager.default.removeItem(at: chunkURL) }
        return try? String(contentsOf: chunkURL, encoding: .utf8)
    }

    func diagLog(_ line: String) {
        let url = supportDir.appendingPathComponent("espaces-diag.log")
        let free = os_proc_available_memory() / 1_048_576
        let text = "\(ISO8601DateFormatter().string(from: Date())) [app libre \(free) Mo] \(line)\n"
        guard let data = text.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() }
        else { try? data.write(to: url) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagLog("PAGE TUÉE : rechargement")
        webView.reload()
    }
}

/// Scribble est permis partout, sauf quand une feuille manuscrite est ouverte
final class ScribbleGate: NSObject, UIScribbleInteractionDelegate {
    var blocked = false
    func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool { !blocked }
}

/// Les gestes de l'Apple Pencil : la page applique l'action choisie dans les Réglages de l'iPad
extension WebHostController: UIPencilInteractionDelegate {
    func sendPencil(_ kind: String, action: String, at point: CGPoint?) {
        var d: [String: Any] = ["kind": kind, "action": action]
        if let p = point { d["x"] = p.x; d["y"] = p.y }
        guard let data = try? JSONSerialization.data(withJSONObject: d), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__pencil && window.__pencil(\(json))", completionHandler: nil)
    }

    static func name(_ a: UIPencilPreferredAction) -> String {
        switch a {
        case .switchEraser: return "eraser"
        case .switchPrevious: return "previous"
        case .showColorPalette: return "palette"
        case .ignore: return "ignore"
        default:
            if #available(iOS 17.5, *), a == .showInkAttributes { return "attributes" }
            return "palette"
        }
    }

    // iPadOS plus anciens : un double-toucher, sans position
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        sendPencil("tap", action: Self.name(UIPencilInteraction.preferredTapAction), at: nil)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        sendPencil("tap", action: Self.name(UIPencilInteraction.preferredTapAction), at: tap.hoverPose?.location)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended else { return }
        sendPencil("squeeze", action: Self.name(UIPencilInteraction.preferredSqueezeAction), at: squeeze.hoverPose?.location)
    }
}

/// La vue de la page : le menu du texte (appui long, ou clic secondaire au trackpad) gagne une entrée
/// « Plus d'options… », qui ouvre le menu complet de l'éditeur, comme le clic droit sur Mac.
final class EspacesWebView: WKWebView {
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        let more = UIAction(title: "Plus d’options…", image: UIImage(systemName: "ellipsis.circle")) { [weak self] _ in
            self?.evaluateJavaScript("window.__editorMenu && window.__editorMenu()", completionHandler: nil)
        }
        builder.insertChild(UIMenu(title: "", options: .displayInline, children: [more]), atEndOfMenu: .root)
    }
}
