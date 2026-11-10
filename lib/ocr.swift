// Prints "== <path>" and the text of every frame or page, each drawn on white and, where it has an
// alpha channel, on black as well, so dark and light text on a transparent ground both read. An
// image that cannot be decoded or recognised gets no block, so the caller counts it as not read.
import CoreGraphics
import Foundation
import ImageIO
import Vision

func recognise(_ img: CGImage, on ground: CGColor) throws -> [String] {
  let ctx = CGContext(
    data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  let rect = CGRect(x: 0, y: 0, width: img.width, height: img.height)
  ctx.setFillColor(ground)
  ctx.fill(rect)
  ctx.draw(img, in: rect)
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .fast
  req.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: ctx.makeImage()!, options: [:]).perform([req])
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
      if ![.none, .noneSkipFirst, .noneSkipLast].contains(img.alphaInfo) {
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
