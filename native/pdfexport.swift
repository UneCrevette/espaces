// Espaces — exporter une page en PDF (Mac et iPad).
// La page est mise en forme dans une vue WebKit invisible, à la largeur du texte d'une feuille A4 ; elle est ensuite
// découpée en tranches de la hauteur d'une page, coupées entre deux paragraphes (jamais au milieu d'une ligne),
// et chaque tranche est posée, en vectoriel, sur une page A4 avec ses marges.

import Foundation
import WebKit
import CoreGraphics

final class PagePDF: NSObject, WKNavigationDelegate {
    static let pageW: CGFloat = 595.2, pageH: CGFloat = 841.8, margin: CGFloat = 56
    static var textW: CGFloat { pageW - 2 * margin }
    static var textH: CGFloat { pageH - 2 * margin }

    let webView: WKWebView
    private let slide: CGSize?   // un diaporama : chaque tranche devient une page entière, de cette taille
    private let done: (Data?, String?) -> Void
    private var finished = false

    /// `host` pose la vue quelque part hors de l'écran (WebKit ne met en page qu'une vue rattachée à une fenêtre)
    init(html: String, base: URL, slide: CGSize? = nil, host: (WKWebView) -> Void, done: @escaping (Data?, String?) -> Void) {
        webView = WKWebView(frame: CGRect(origin: .zero, size: slide ?? CGSize(width: Self.textW, height: Self.textH)))
        self.slide = slide
        self.done = done
        super.init()
        webView.navigationDelegate = self
        host(webView)
        webView.loadHTMLString(html, baseURL: base)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // un instant pour que les images et les polices soient posées
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.cut() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }

    private func finish(_ data: Data?, _ error: String?) {
        guard !finished else { return }
        finished = true
        webView.removeFromSuperview()
        done(data, error)
    }

    /// La page dit elle-même où couper : sous un paragraphe, une image, un titre…
    private func cut() {
        webView.evaluateJavaScript("window.__breaks(\(Double(Self.textH)))") { result, error in
            guard let cuts = result as? [NSNumber], !cuts.isEmpty else { self.finish(nil, error?.localizedDescription ?? "Mise en page impossible"); return }
            var slices: [CGRect] = []
            var y: CGFloat = 0
            for c in cuts.map({ CGFloat($0.doubleValue) }) where c > y {
                slices.append(CGRect(x: 0, y: y, width: self.slide?.width ?? Self.textW, height: c - y))
                y = c
            }
            self.render(slices, at: 0, into: [])
        }
    }

    private func render(_ slices: [CGRect], at i: Int, into pages: [Data]) {
        guard i < slices.count else { compose(pages); return }
        let config = WKPDFConfiguration()
        config.rect = slices[i]
        webView.createPDF(configuration: config) { result in
            switch result {
            case .success(let data): self.render(slices, at: i + 1, into: pages + [data])
            case .failure(let error): self.finish(nil, error.localizedDescription)
            }
        }
    }

    /// Chaque tranche, en haut d'une page A4, entre les marges
    private func compose(_ pages: [Data]) {
        let out = NSMutableData()
        var box = CGRect(origin: .zero, size: slide ?? CGSize(width: Self.pageW, height: Self.pageH))
        let margin = slide == nil ? Self.margin : 0
        guard let consumer = CGDataConsumer(data: out as CFMutableData), let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else {
            finish(nil, "PDF impossible"); return
        }
        for data in pages {
            guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider), let page = doc.page(at: 1) else { continue }
            let r = page.getBoxRect(.mediaBox)
            ctx.beginPDFPage(nil)
            ctx.saveGState()
            ctx.translateBy(x: margin - r.minX, y: box.height - margin - r.height - r.minY)
            ctx.drawPDFPage(page)
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
        finish(out as Data, nil)
    }
}
