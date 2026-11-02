// Prints the recognized text of each image path given, one block per file, prefixed "== path".
import AppKit
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  print("== \(path)")
  guard let img = NSImage(contentsOfFile: path),
    let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .fast
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  for obs in req.results ?? [] { if let t = obs.topCandidates(1).first { print(t.string) } }
}
