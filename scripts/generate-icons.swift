import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "extension/icons", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 48, 128] {
    let canvas = NSSize(width: size, height: size)
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Failed to create icon canvas")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    NSColor(calibratedRed: 0.08, green: 0.29, blue: 0.65, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(origin: .zero, size: canvas), xRadius: CGFloat(size) * 0.22, yRadius: CGFloat(size) * 0.22).fill()
    NSColor.white.setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = CGFloat(size) * 0.085
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    let unit = CGFloat(size)
    arrow.move(to: NSPoint(x: unit * 0.50, y: unit * 0.76))
    arrow.line(to: NSPoint(x: unit * 0.50, y: unit * 0.34))
    arrow.move(to: NSPoint(x: unit * 0.32, y: unit * 0.52))
    arrow.line(to: NSPoint(x: unit * 0.50, y: unit * 0.34))
    arrow.line(to: NSPoint(x: unit * 0.68, y: unit * 0.52))
    arrow.move(to: NSPoint(x: unit * 0.28, y: unit * 0.24))
    arrow.line(to: NSPoint(x: unit * 0.72, y: unit * 0.24))
    arrow.stroke()
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Failed to render icon")
    }
    try png.write(to: output.appendingPathComponent("\(size).png"))
}
