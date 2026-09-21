import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_EXTRACTED_DOCUMENT_BYTES,
  extractDocument,
  normalizeExtractedDocument,
  validateDocumentUpload,
} from "../src/document-extraction.mjs";

const encoded = (value) => new TextEncoder().encode(value);
const pdfBytes = () => encoded("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
const jpegBytes = (marker = 0xe0) => new Uint8Array([0xff, 0xd8, 0xff, marker, 0xff, 0xd9]);
const pngBytes = () => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0x00, 0x00, 0x00, 0x00,
]);
const webpBytes = () => new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x00, 0x00, 0x00, 0x00,
]);

test("document upload validation binds extension, MIME type and file signature", () => {
  const fixtures = [
    ["report.pdf", "application/pdf", pdfBytes()],
    ["photo.jpg", "image/jpeg", jpegBytes()],
    ["photo.jpeg", "image/jpeg", jpegBytes(0xe1)],
    ["scan.png", "image/png", pngBytes()],
    ["diagram.webp", "image/webp", webpBytes()],
  ];
  for (const [name, mimeType, bytes] of fixtures) {
    assert.deepEqual(validateDocumentUpload(name, mimeType, bytes), {
      name,
      mimeType,
      kind: mimeType === "application/pdf" ? "PDF" : "图片",
    });
  }

  assert.throws(
    () => validateDocumentUpload("renamed.jpg", "image/jpeg", encoded("not an image")),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateDocumentUpload("renamed.png", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff])),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateDocumentUpload("active.svg", "image/svg+xml", encoded("<svg/>")),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateDocumentUpload("../report.pdf", "application/pdf", pdfBytes()),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validateDocumentUpload("truncated.pdf", "application/pdf", encoded("%PDF-1.7")),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateDocumentUpload("truncated.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff])),
    (error) => error.status === 415,
  );
});

test("document upload validation rejects empty and oversized files", () => {
  assert.throws(
    () => validateDocumentUpload("report.pdf", "application/pdf", new Uint8Array()),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validateDocumentUpload(
      "report.pdf",
      "application/pdf",
      new Uint8Array(MAX_DOCUMENT_UPLOAD_BYTES + 1),
    ),
    (error) => error.status === 413,
  );
});

test("extracted document text is normalized without a 30000-character ceiling", () => {
  assert.equal(
    normalizeExtractedDocument("  第一行自动识别文字\r\n第二行\u0000正文内容  "),
    "第一行自动识别文字\n第二行正文内容",
  );
  assert.throws(
    () => normalizeExtractedDocument("太短"),
    (error) => error.status === 422,
  );
  const longText = "文".repeat(30_001);
  assert.equal(normalizeExtractedDocument(longText), longText);
  assert.equal(MAX_EXTRACTED_DOCUMENT_BYTES, 5 * 1024 * 1024);
  assert.throws(
    () => normalizeExtractedDocument("文".repeat(Math.floor(MAX_EXTRACTED_DOCUMENT_BYTES / 3) + 1)),
    (error) => error.status === 413 && /5 MB/u.test(error.message),
  );
});

test("Cloudflare conversion receives a transient Blob and returns bounded text", async () => {
  let captured;
  const ai = {
    async toMarkdown(document, options) {
      captured = { document, options };
      return {
        id: "conversion-1",
        name: document.name,
        mimeType: document.blob.type,
        format: "markdown",
        tokens: 18,
        data: "# 检测结果\n\n这是自动识别出的正文内容。",
      };
    },
  };
  const upload = { name: "report.pdf", mimeType: "application/pdf", kind: "PDF" };
  const result = await extractDocument(ai, upload, encoded("%PDF-1.7\nbody"));
  assert.deepEqual(result, { text: "# 检测结果\n\n这是自动识别出的正文内容。", tokens: 18 });
  assert.equal(captured.document.name, "report.pdf");
  assert.equal(captured.document.blob.type, "application/pdf");
  assert.equal(captured.options.conversionOptions.output.format, "markdown");
  assert.equal(captured.options.conversionOptions.pdf.images.convert, true);
  assert.equal(Object.hasOwn(captured.options.conversionOptions.pdf.images, "maxConvertedImages"), false);
});

test("Cloudflare conversion failures expose safe format-specific errors", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const upload = { name: "scan.png", mimeType: "image/png", kind: "图片" };
  const bytes = pngBytes();
  await assert.rejects(
    () => extractDocument({ async toMarkdown() { return { format: "error", error: "vendor detail" }; } }, upload, bytes),
    (error) => error.status === 422 && /图片/u.test(error.message) && !error.message.includes("PDF") && !error.message.includes("vendor detail"),
  );
  await assert.rejects(
    () => extractDocument({ async toMarkdown() { throw new Error("secret vendor failure"); } }, upload, bytes),
    (error) => error.status === 502 && !error.message.includes("secret vendor failure"),
  );
  const limited = new Error("secret quota detail");
  limited.name = "RateLimitedError";
  await assert.rejects(
    () => extractDocument({ async toMarkdown() { throw limited; } }, upload, bytes),
    (error) => error.status === 429 && !error.message.includes("secret quota detail"),
  );
  assert.equal(logged.mock.callCount(), 3);
});
