// Espaces — enregistrer une note vocale (Mac, iPad, iPhone).
// Un fichier AAC mono, léger : il voyage en base64 dans la page, comme les images, et se synchronise avec elle.

import Foundation
import AVFoundation

final class VoiceRecorder: NSObject {
    private var recorder: AVAudioRecorder?
    private var url: URL { FileManager.default.temporaryDirectory.appendingPathComponent("espaces-voix.m4a") }
    // ouvrir le micro prend du temps : jamais sur le fil de l'interface
    private let queue = DispatchQueue(label: "app.espaces.voice", qos: .userInteractive)

    func start(done: @escaping (String?) -> Void) {
        let reply: (String?) -> Void = { error in DispatchQueue.main.async { done(error) } }
        let go: (Bool) -> Void = { granted in
            self.queue.async {
                guard granted else { reply("Micro refusé : autorisez-le dans les Réglages"); return }
                // juste après l'autorisation, le micro n'est pas toujours prêt : un second essai, un instant plus tard
                if let error = self.begin() {
                    self.queue.asyncAfter(deadline: .now() + 0.4) { reply(self.begin() == nil ? nil : error) }
                } else { reply(nil) }
            }
        }
        #if os(iOS)
        AVAudioSession.sharedInstance().requestRecordPermission(go)
        #else
        AVCaptureDevice.requestAccess(for: .audio, completionHandler: go)
        #endif
    }

    private func begin() -> String? {
        do {
            #if os(iOS)
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try s.setActive(true)
            #endif
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22050, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000]
            try? FileManager.default.removeItem(at: url)
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.isMeteringEnabled = true
            r.prepareToRecord()
            guard r.record() else { return "Enregistrement impossible" }
            recorder = r
            return nil
        } catch { return error.localizedDescription }
    }

    /// Le niveau du micro, de 0 à 1 (pour dessiner l'onde pendant qu'on parle)
    func level(done: @escaping (Double) -> Void) {
        queue.async {
            var v = 0.0
            if let r = self.recorder {
                r.updateMeters()
                v = max(0, min(1, (Double(r.averagePower(forChannel: 0)) + 50) / 50))
            }
            DispatchQueue.main.async { done(v) }
        }
    }

    /// Termine l'enregistrement ; `keep` faux : on le jette. Rien de rendu si le fichier ne contient pas de son.
    func stop(keep: Bool, done: @escaping ([String: Any]?) -> Void) {
        queue.async {
            var out: [String: Any]?
            if let r = self.recorder {
                let seconds = r.currentTime
                r.stop()
                self.recorder = nil
                #if os(iOS)
                // Spotify, Deezer… reprennent là où le micro les a interrompus
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                // le son de l'app reprend comme avant : la musique joue, même en mode silencieux
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try? AVAudioSession.sharedInstance().setActive(true)
                #endif
                if keep, seconds > 0.1, let data = try? Data(contentsOf: self.url), data.count > 1000 {
                    out = ["data": data.base64EncodedString(), "seconds": seconds]
                }
                try? FileManager.default.removeItem(at: self.url)
            }
            DispatchQueue.main.async { done(out) }
        }
    }
}
