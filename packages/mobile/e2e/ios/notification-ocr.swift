import AppKit
import Foundation
import Vision

private struct Observation: Codable {
  let text: String
  let confidence: Float
  let minX: Double
  let minY: Double
  let width: Double
  let height: Double
}

private struct Analysis: Codable {
  let pixelWidth: Int
  let pixelHeight: Int
  let observations: [Observation]
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else {
  fail("Usage: notification-ocr.swift <simulator-screenshot.png>")
}

let screenshotPath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: screenshotPath) else {
  fail("The simulator screenshot could not be decoded.")
}
var proposedRect = NSRect(origin: .zero, size: image.size)
guard
  let cgImage = image.cgImage(
    forProposedRect: &proposedRect,
    context: nil,
    hints: nil
  )
else {
  fail("The simulator screenshot did not expose a CGImage.")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]

do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
  let recognized: [VNRecognizedTextObservation] = request.results ?? []
  let observations: [Observation] = recognized.compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }
    let bounds = observation.boundingBox
    return Observation(
      text: candidate.string,
      confidence: candidate.confidence,
      minX: bounds.minX,
      minY: bounds.minY,
      width: bounds.width,
      height: bounds.height
    )
  }
  let analysis = Analysis(
    pixelWidth: cgImage.width,
    pixelHeight: cgImage.height,
    observations: observations
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  FileHandle.standardOutput.write(try encoder.encode(analysis))
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("Vision text recognition failed: \(error.localizedDescription)")
}
