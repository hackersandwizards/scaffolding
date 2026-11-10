// Prints "== <path>" and the text of every frame or page, each drawn on white and, where a pixel is
// transparent, on black as well, so dark and light text on a transparent ground both read. An
// image that cannot be decoded, drawn or recognised gets no block, so the caller counts it as not
// read.
import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Unread: Error {}

func context(_ img: CGImage, _ alpha: CGImageAlphaInfo) throws -> CGContext {
  guard
    let ctx = CGContext(
      data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: alpha.rawValue)
  else { throw Unread() }
  return ctx
}

func transparent(_ img: CGImage) throws -> Bool {
  if [.none, .noneSkipFirst, .noneSkipLast].contains(img.alphaInfo) { return false }
  let ctx = try context(img, .premultipliedLast)
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  guard let data = ctx.data else { throw Unread() }
  let bytes = data.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * img.height)
  for y in 0..<img.height {
    for x in 0..<img.width where bytes[y * ctx.bytesPerRow + x * 4 + 3] < 255 { return true }
  }
  return false
}

func recognise(_ img: CGImage, on ground: CGColor) throws -> [String] {
  let ctx = try context(img, .noneSkipLast)
  let rect = CGRect(x: 0, y: 0, width: img.width, height: img.height)
  ctx.setFillColor(ground)
  ctx.fill(rect)
  ctx.draw(img, in: rect)
  guard let drawn = ctx.makeImage() else { throw Unread() }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .fast
  req.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: drawn, options: [:]).perform([req])
  return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

for path in CommandLine.arguments.dropFirst() {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else {
    continue
  }
  let count = CGImageSourceGetCount(src)
  var lines: [String] = []
  var read = count > 0
  for i in 0..<count {
    guard let img = CGImageSourceCreateImageAtIndex(src, i, nil) else {
      read = false
      break
    }
    // Vision refuses a side under 3 pixels, too small to hold a letter.
    if img.width < 3 || img.height < 3 { continue }
    do {
      lines += try recognise(img, on: CGColor(gray: 1, alpha: 1))
      if try transparent(img) {
        lines += try recognise(img, on: CGColor(gray: 0, alpha: 1))
      }
    } catch {
      read = false
      break
    }
  }
  guard read else { continue }
  print("== \(path)")
  lines.forEach { print($0) }
}
