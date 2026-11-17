// Espaces — ce qui sert à la note rapide sur iPhone et iPad : la photo prise sur le moment, et le lieu où l'on est.

import UIKit
import CoreLocation

/// Le lieu d'une note : une position, et son nom quand le réseau le permet
final class PlaceFinder: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: [([String: Any]?) -> Void] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func find(_ done: @escaping ([String: Any]?) -> Void) {
        waiting.append(done)
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .denied, .restricted: finish(nil)
        default: manager.requestLocation()
        }
    }

    private func finish(_ value: [String: Any]?) {
        let list = waiting
        waiting = []
        list.forEach { $0(value) }
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        guard !waiting.isEmpty else { return }
        switch m.authorizationStatus {
        case .notDetermined: break
        case .denied, .restricted: finish(nil)
        default: m.requestLocation()
        }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) { finish(nil) }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return finish(nil) }
        var out: [String: Any] = ["lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude, "speed": max(0, loc.speed)]
        CLGeocoder().reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "fr_FR")) { marks, _ in
            if let p = marks?.first {
                let street = p.thoroughfare ?? p.name
                out["place"] = [street, p.locality].compactMap { $0 }.joined(separator: ", ")
            }
            self.finish(out)
        }
    }
}

/// La photo prise avec l'appareil, rendue en JPEG raisonnable pour tenir dans la page
final class PhotoTaker: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private var done: ((String?) -> Void)?

    func take(from host: UIViewController, done: @escaping (String?) -> Void) {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { done(nil); return }
        self.done = done
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = self
        host.present(p, animated: true)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        done?(nil)
        done = nil
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        let image = info[.originalImage] as? UIImage
        let finish = done
        done = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let url = image.flatMap(Self.encode)
            DispatchQueue.main.async { finish?(url) }
        }
    }

    private static func encode(_ image: UIImage) -> String? {
        let side: CGFloat = 1800, big = max(image.size.width, image.size.height), k = min(1, side / big)
        let size = CGSize(width: image.size.width * k, height: image.size.height * k)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return small.jpegData(compressionQuality: 0.72).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
    }
}
