// Espaces — lire l'écriture manuscrite d'une feuille (Mac et iPad), hors ligne, avec la reconnaissance d'Apple.
// La page envoie une image des traits (encre noire sur fond blanc) ; on rend le texte, ligne par ligne, dans l'ordre de lecture.

import Foundation
import Vision
import ImageIO

enum InkText {
    static func recognize(pngBase64: String, done: @escaping (String?, String?) -> Void) {
        let b64 = pngBase64.components(separatedBy: ",").last ?? pngBase64
        guard let data = Data(base64Encoded: b64),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { done(nil, "Image illisible"); return }
        let request = VNRecognizeTextRequest { req, error in
            if let error { DispatchQueue.main.async { done(nil, error.localizedDescription) }; return }
            let obs = (req.results as? [VNRecognizedTextObservation]) ?? []
            // de haut en bas, puis de gauche à droite ; deux morceaux à la même hauteur forment une seule ligne
            let items = obs.compactMap { o -> (CGRect, String)? in
                guard let s = o.topCandidates(1).first?.string else { return nil }
                return (o.boundingBox, s)
            }.sorted { a, b in
                abs(a.0.midY - b.0.midY) > min(a.0.height, b.0.height) * 0.5 ? a.0.midY > b.0.midY : a.0.minX < b.0.minX
            }
            var lines: [(CGFloat, String)] = []
            for (box, s) in items {
                if let last = lines.last, abs(last.0 - box.midY) < box.height * 0.5 { lines[lines.count - 1].1 += " " + s }
                else { lines.append((box.midY, s)) }
            }
            let text = lines.map { $0.1 }.joined(separator: "\n")
            DispatchQueue.main.async { done(text, nil) }
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        // le français d'abord, quand cette version du système sait le lire
        let wanted = ["fr-FR", "en-US"], known = (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
        request.recognitionLanguages = wanted.filter { known.contains($0) }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) }
            catch { DispatchQueue.main.async { done(nil, error.localizedDescription) } }
        }
    }
}
