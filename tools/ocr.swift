import AppKit
import Foundation
import PDFKit
import Vision

struct PageResult: Codable {
    let page: Int
    let text: String
}

struct Result: Codable {
    let pages: [PageResult]
    let text: String
}

func recognize(_ image: CGImage, page: Int) throws -> PageResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let sorted = observations.sorted { a, b in
        let dy = abs(a.boundingBox.midY - b.boundingBox.midY)
        if dy > 0.01 { return a.boundingBox.midY > b.boundingBox.midY }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    let text = sorted.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    return PageResult(page: page, text: text)
}

func cgImage(_ image: NSImage) -> CGImage? {
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func ocrImage(path: String) throws -> [PageResult] {
    guard let image = NSImage(contentsOfFile: path) else {
        throw NSError(domain: "ocr", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot load image"])
    }
    guard let cg = cgImage(image) else {
        throw NSError(domain: "ocr", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot convert image"])
    }
    return [try recognize(cg, page: 1)]
}

func ocrPDF(path: String, maxPages: Int) throws -> [PageResult] {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        throw NSError(domain: "ocr", code: 3, userInfo: [NSLocalizedDescriptionKey: "cannot load pdf"])
    }
    var results: [PageResult] = []
    let total = min(doc.pageCount, maxPages)
    for i in 0..<total {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let width: CGFloat = 1600
        let height = width * max(0.2, bounds.height / max(1, bounds.width))
        let thumb = page.thumbnail(of: NSSize(width: width, height: height), for: .mediaBox)
        guard let cg = cgImage(thumb) else { continue }
        results.append(try recognize(cg, page: i + 1))
    }
    return results
}

let args = CommandLine.arguments.dropFirst()
guard let path = args.first else {
    FileHandle.standardError.write(Data("usage: ocr <image|pdf> [maxPages]\n".utf8))
    exit(2)
}
let maxPages = args.dropFirst().first.flatMap { Int($0) } ?? 10

do {
    let pages = path.lowercased().hasSuffix(".pdf")
        ? try ocrPDF(path: path, maxPages: maxPages)
        : try ocrImage(path: path)
    let text = pages.map { $0.text }.joined(separator: "\n\n")
    let result = Result(pages: pages, text: text)
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("ocr error: \(error.localizedDescription)\n".utf8))
    exit(1)
}
