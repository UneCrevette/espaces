// Dessine l'icône de l'Installeur : la roue de cartes d'Espaces (voir native/icon.swift), avec au centre une flèche
// qui descend, dans le rouge brique de la roue : l'app qu'on installe.
import Cocoa

let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
let colors: [NSColor] = [
    NSColor(srgbRed: 0.78, green: 0.27, blue: 0.17, alpha: 1), NSColor(srgbRed: 0.09, green: 0.09, blue: 0.09, alpha: 1),
    NSColor(srgbRed: 0.87, green: 0.89, blue: 0.84, alpha: 1), NSColor(srgbRed: 0.91, green: 0.86, blue: 0.79, alpha: 1),
    NSColor(srgbRed: 0.54, green: 0.56, blue: 0.47, alpha: 1)
]

func draw(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let inset = s * 0.1
    let bg = NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset), xRadius: s * 0.18, yRadius: s * 0.18)
    NSColor.white.setFill(); bg.fill()
    NSColor(white: 0, alpha: 0.08).setStroke(); bg.lineWidth = s * 0.004; bg.stroke()
    let k: CGFloat = 0.8
    let n = 16, inner = s * 0.183 * k, h = s * 0.195 * k, w = s * 0.073 * k, c = s * 0.016 * k
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.saveGState()
    ctx.translateBy(x: s / 2, y: s / 2)
    for i in 0..<n {
        ctx.saveGState()
        ctx.rotate(by: -CGFloat(i) / CGFloat(n) * 2 * .pi)
        colors[i % colors.count].setFill()
        NSBezierPath(roundedRect: NSRect(x: -w / 2, y: inner, width: w, height: h), xRadius: c, yRadius: c).fill()
        ctx.restoreGState()
    }
    ctx.restoreGState()
    // la flèche, au cœur de la roue : une tige et une pointe, aux bouts arrondis comme les cartes
    let arrow = NSBezierPath()
    let cx = s / 2, top = s / 2 + inner * 0.62, tip = s / 2 - inner * 0.62, head = inner * 0.5
    arrow.move(to: NSPoint(x: cx, y: top)); arrow.line(to: NSPoint(x: cx, y: tip))
    arrow.move(to: NSPoint(x: cx - head, y: tip + head)); arrow.line(to: NSPoint(x: cx, y: tip)); arrow.line(to: NSPoint(x: cx + head, y: tip + head))
    arrow.lineWidth = max(1.2, w * 0.62)
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    colors[0].setStroke()
    arrow.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! draw(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
