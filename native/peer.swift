// Espaces — lien direct entre appareils sur le même réseau (Mac et iPad).
// Chaque appareil s'annonce (Bonjour) et cherche les autres ; dès qu'un changement est fait, la copie partagée
// part directement vers eux, en moins d'une seconde. iCloud reste la base quand les appareils ne se voient pas.
// Seuls les appareils qui partagent la même clé (rangée dans la copie iCloud) s'écoutent.

import Foundation
import Network

final class PeerLink {
    static let serviceType = "_espaces._tcp"
    /// Le nom de cet appareil sur le réseau : tiré au hasard à chaque lancement
    let me = UUID().uuidString
    var key: String
    let onMessage: (String) -> Void
    /// Un appareil vient d'être trouvé : on lui envoie aussitôt l'état d'ici
    var onJoin: (() -> Void)?
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var dialing = Set<String>()

    init(key: String, onMessage: @escaping (String) -> Void) {
        self.key = key
        self.onMessage = onMessage
    }

    var parameters: NWParameters {
        let p = NWParameters.tcp
        p.includePeerToPeer = true
        return p
    }

    func start() {
        guard listener == nil else { return }
        if let l = try? NWListener(using: parameters) {
            l.service = NWListener.Service(name: me, type: Self.serviceType)
            l.newConnectionHandler = { [weak self] c in self?.adopt(c, dialed: nil) }
            l.start(queue: .main)
            listener = l
        }
        let b = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: parameters)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            for r in results {
                // une seule connexion par paire d'appareils : c'est celui dont le nom est le plus grand qui appelle
                guard case let .service(name, _, _, _) = r.endpoint, name < self.me, !self.dialing.contains(name) else { continue }
                self.dialing.insert(name)
                self.adopt(NWConnection(to: r.endpoint, using: self.parameters), dialed: name)
            }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        listener?.cancel()
        browser?.cancel()
        connections.values.forEach { $0.cancel() }
        connections = [:]
        dialing = []
        listener = nil
        browser = nil
    }

    /// Après un retour au premier plan (iPad), le réseau a pu être coupé : on repart de zéro
    func restart() {
        stop()
        start()
    }

    private func adopt(_ c: NWConnection, dialed: String?) {
        let id = ObjectIdentifier(c)
        connections[id] = c
        c.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.receive(c)
                self?.onJoin?()
            case .failed, .cancelled:
                self?.connections[id] = nil
                if let dialed { self?.dialing.remove(dialed) }
            default:
                break
            }
        }
        c.start(queue: .main)
    }

    /// Chaque message : sa longueur sur 4 octets, puis la clé et la copie partagée en JSON
    func send(_ text: String) {
        guard let body = try? JSONSerialization.data(withJSONObject: ["k": key, "d": text]) else { return }
        let n = UInt32(body.count)
        let frame = Data([UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]) + body
        for c in connections.values {
            if case .ready = c.state { c.send(content: frame, completion: .contentProcessed { _ in }) }
        }
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] head, _, done, error in
            guard let self, let head, head.count == 4, error == nil else {
                if done || error != nil { c.cancel() }
                return
            }
            let n = Int(head.reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
            guard n > 0, n < 300_000_000 else { c.cancel(); return }
            c.receive(minimumIncompleteLength: n, maximumLength: n) { body, _, _, error in
                if let body, body.count == n,
                   let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                   obj["k"] as? String == self.key, let text = obj["d"] as? String {
                    self.onMessage(text)
                }
                if error == nil { self.receive(c) } else { c.cancel() }
            }
        }
    }
}
