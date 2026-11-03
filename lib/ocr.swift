// An image that cannot be decoded gets no block, so the caller counts it as not read.
import AppKit
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path),
    let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { continue }
  print("== \(path)")
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .fast
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  for obs in req.results ?? [] { if let t = obs.topCandidates(1).first { print(t.string) } }
}
