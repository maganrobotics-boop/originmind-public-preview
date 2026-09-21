import { PublicError } from "./errors.mjs";

export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_DOCUMENT_BYTES = 5 * 1024 * 1024;

const FORMATS = Object.freeze({
  "application/pdf": Object.freeze({ extensions: Object.freeze(["pdf"]), kind: "PDF" }),
  "image/jpeg": Object.freeze({ extensions: Object.freeze(["jpg", "jpeg"]), kind: "图片" }),
  "image/png": Object.freeze({ extensions: Object.freeze(["png"]), kind: "图片" }),
  "image/webp": Object.freeze({ extensions: Object.freeze(["webp"]), kind: "图片" }),
});

function normalizedMimeType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function extensionOf(name) {
  const separator = name.lastIndexOf(".");
  return separator > 0 && separator < name.length - 1 ? name.slice(separator + 1).toLowerCase() : "";
}

function startsWith(bytes, signature) {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function includesNearEnd(bytes, signature, windowSize = 1_024) {
  const start = Math.max(0, bytes.length - windowSize);
  for (let offset = bytes.length - signature.length; offset >= start; offset -= 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

function uint32BigEndian(bytes, offset) {
  return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function uint32LittleEndian(bytes, offset) {
  return (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + ((bytes[offset + 3] << 24) >>> 0)) >>> 0;
}

function matchesSignature(mimeType, bytes) {
  if (mimeType === "application/pdf") {
    return bytes.length >= 12 &&
      startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) &&
      includesNearEnd(bytes, [0x25, 0x25, 0x45, 0x4f, 0x46]);
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 4 &&
      startsWith(bytes, [0xff, 0xd8, 0xff]) &&
      includesNearEnd(bytes, [0xff, 0xd9]);
  }
  if (mimeType === "image/png") {
    return bytes.length >= 45 &&
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      uint32BigEndian(bytes, 8) === 13 &&
      startsWith(bytes.slice(12), [0x49, 0x48, 0x44, 0x52]) &&
      uint32BigEndian(bytes, 16) > 0 &&
      uint32BigEndian(bytes, 20) > 0 &&
      includesNearEnd(bytes, [0x49, 0x45, 0x4e, 0x44], 16);
  }
  if (mimeType === "image/webp") {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 16 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 &&
      uint32LittleEndian(bytes, 4) + 8 === bytes.length &&
      bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 &&
      [0x20, 0x4c, 0x58].includes(bytes[15]);
  }
  return false;
}

export function validateDocumentUpload(nameValue, mimeTypeValue, bytes) {
  const name = typeof nameValue === "string" ? nameValue.normalize("NFC").trim() : "";
  if (
    !name ||
    name.length > 180 ||
    /[\\/\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new PublicError("文件名不正确，请重新选择文件。", 400);
  }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PublicError("文件为空，请重新选择文件。", 400);
  }
  if (bytes.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new PublicError("文件不能超过 10 MB，请压缩或拆分后重试。", 413);
  }

  const mimeType = normalizedMimeType(mimeTypeValue);
  const format = FORMATS[mimeType];
  const extension = extensionOf(name);
  if (!format || !format.extensions.includes(extension) || !matchesSignature(mimeType, bytes)) {
    throw new PublicError("文件格式无法识别，仅支持 PDF、JPG、PNG 和 WebP。", 415);
  }
  return { name, mimeType, kind: format.kind };
}

export function normalizeExtractedDocument(value) {
  if (typeof value !== "string") throw new PublicError("文件解析失败，请稍后重试。", 502);
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  if (text.length < 10) {
    throw new PublicError("未识别到足够内容，请换一份清晰文件或手动填写正文。", 422);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_EXTRACTED_DOCUMENT_BYTES) {
    throw new PublicError("解析成功，但正文超过 5 MB，请压缩或拆分文件后再上传。", 413);
  }
  return text;
}

export async function extractDocument(ai, upload, bytes) {
  if (typeof ai?.toMarkdown !== "function") {
    throw new PublicError("自动解析服务暂不可用，请稍后重试。", 503);
  }

  let result;
  try {
    result = await ai.toMarkdown(
      {
        name: upload.name,
        blob: new Blob([bytes], { type: upload.mimeType }),
      },
      {
        conversionOptions: {
          output: { format: "markdown" },
          pdf: { images: { convert: true } },
        },
      },
    );
  } catch (error) {
    const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
      ? error.name
      : "UnknownError";
    const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(error.code)
      ? error.code
      : undefined;
    console.error("Document conversion failed", { name, ...(code ? { code } : {}) });
    if (name === "RateLimitedError" || name === "QuotaReachedError") {
      throw new PublicError("文件解析服务繁忙或额度已用完，请稍后重试。", 429);
    }
    if (name === "MaxFileSizeError") {
      throw new PublicError("文件超出解析服务限制，请压缩或拆分后重试。", 413);
    }
    if (name === "BadRequestError") {
      throw new PublicError("文件无法解析，请确认文件未加密且内容完整。", 422);
    }
    throw new PublicError("文件解析失败，请稍后重试。", 502);
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PublicError("文件解析失败，请稍后重试。", 502);
  }
  if (result.format === "error") {
    console.error("Document conversion returned error format", { name: "ConversionResultError" });
    throw new PublicError(
      upload.kind === "PDF"
        ? "PDF 无法解析，请确认文件未加密、内容完整且扫描清晰。"
        : "图片无法解析，请换一张完整、清晰的图片。",
      422,
    );
  }
  if (result.format !== "markdown" && result.format !== "text") {
    throw new PublicError("文件解析结果异常，请稍后重试。", 502);
  }

  const text = normalizeExtractedDocument(result.data);
  const tokens = Number.isInteger(result.tokens) && result.tokens >= 0 ? result.tokens : null;
  return { text, tokens };
}
