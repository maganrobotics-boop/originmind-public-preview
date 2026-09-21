"use strict";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_MAX_ENTRIES = 100;
const ZIP_MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const ZIP_ALLOWED_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:webp|png|jpe?g)$/iu;
const ZIP_INDEX = "index.md";

function zipError(message) {
  const error = new Error(message);
  error.name = "ZipKnowledgePackageError";
  return error;
}

function decodeZipName(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
  } catch {
    throw zipError("ZIP 内文件名必须使用 UTF-8 编码。");
  }
}

function normalizeZipPath(path) {
  const value = String(path || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) throw zipError("ZIP 内存在不安全的文件路径。");
  const directory = value.endsWith("/");
  const body = directory ? value.slice(0, -1) : value;
  if (!body) throw zipError("ZIP 内存在不安全的文件路径。");
  const segments = body.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw zipError("ZIP 内存在不安全的文件路径。");
  return directory ? `${body}/` : body;
}

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw zipError("ZIP 文件结构无效或已损坏。");
}

function readZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw zipError("暂不支持分卷 ZIP 文件。");
  if (entryCount < 1 || entryCount > ZIP_MAX_ENTRIES) throw zipError(`ZIP 内最多允许 ${ZIP_MAX_ENTRIES} 个文件。`);
  if (centralOffset + centralSize > eocd) throw zipError("ZIP 中央目录无效。");

  const entries = [];
  let cursor = centralOffset;
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) throw zipError("ZIP 中央目录条目无效。");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > view.byteLength) throw zipError("ZIP 文件名或扩展字段无效。");
    if ((flags & 0x0001) !== 0) throw zipError("暂不支持加密 ZIP 文件。");
    if (method !== 0 && method !== 8) throw zipError("ZIP 仅支持 Store 或 Deflate 压缩方式。");
    const name = normalizeZipPath(decodeZipName(new Uint8Array(arrayBuffer, nameStart, nameLength)));
    if (name.endsWith("/")) {
      cursor = nameEnd + extraLength + commentLength;
      continue;
    }
    compressedTotal += compressedSize;
    uncompressedTotal += uncompressedSize;
    if (compressedTotal > ZIP_MAX_COMPRESSED_BYTES || uncompressedTotal > ZIP_MAX_UNCOMPRESSED_BYTES) throw zipError("ZIP 解压后内容过大，请拆分后重试。");
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw zipError("当前浏览器不支持 ZIP 解压，请使用最新版 Chrome、Edge 或 Android 浏览器。");
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  } catch {
    throw zipError("当前浏览器不支持 ZIP Deflate 解压，请改用 Store 压缩或最新版浏览器。");
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractZipEntry(arrayBuffer, entry) {
  const view = new DataView(arrayBuffer);
  const offset = entry.localOffset;
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER) throw zipError(`${entry.name}：ZIP 本地文件头无效。`);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > view.byteLength) throw zipError(`${entry.name}：ZIP 数据范围无效。`);
  const compressed = new Uint8Array(arrayBuffer, start, entry.compressedSize);
  const bytes = entry.method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);
  if (bytes.byteLength !== entry.uncompressedSize) throw zipError(`${entry.name}：解压后大小校验失败。`);
  return bytes;
}

function validateKnowledgePackage(entries) {
  const names = new Set();
  let indexCount = 0;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (names.has(lower)) throw zipError(`${entry.name}：ZIP 内存在重复路径。`);
    names.add(lower);
    if (lower === ZIP_INDEX) indexCount += 1;
    else if (!ZIP_ALLOWED_ASSET.test(entry.name)) throw zipError(`${entry.name}：ZIP 只允许 index.md 和 assets/ 下的 JPG、PNG、WebP 图片。`);
  }
  if (indexCount !== 1) throw zipError("ZIP 必须且只能包含一个根目录 index.md。");
}

function markdownAssetReferences(markdown) {
  const references = new Set();
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const raw = (match[1] || match[2] || "").split(/[?#]/u, 1)[0];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw path */ }
    if (/^assets\//iu.test(decoded)) references.add(normalizeZipPath(decoded));
  }
  for (const path of knowledgeImageReferences(markdown).keys()) references.add(normalizeZipPath(path));
  return references;
}

async function unpackKnowledgeZip(file) {
  if (file.size > ZIP_MAX_COMPRESSED_BYTES) throw zipError("ZIP 文件不能超过 50 MB，请压缩图片或拆分资料。");
  const arrayBuffer = await file.arrayBuffer();
  const entries = readZipEntries(arrayBuffer);
  validateKnowledgePackage(entries);
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const indexBytes = await extractZipEntry(arrayBuffer, byName.get(ZIP_INDEX));
  let markdown;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(indexBytes).replace(/^\uFEFF/u, "");
  } catch {
    throw zipError("index.md 必须使用 UTF-8 编码。");
  }
  if (!markdown.trim()) throw zipError("index.md 不能为空。");

  const referenced = markdownAssetReferences(markdown);
  const files = [new File([indexBytes], "index.md", { type: "text/markdown", lastModified: file.lastModified })];
  for (const path of [...referenced].sort((left, right) => left.localeCompare(right, "zh-CN"))) {
    const entry = byName.get(path.toLowerCase());
    if (!entry) throw zipError(`index.md 引用了缺失图片：${path}`);
    const bytes = await extractZipEntry(arrayBuffer, entry);
    const extension = path.split(".").at(-1).toLowerCase();
    const type = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    files.push(new File([bytes], path, { type, lastModified: file.lastModified }));
  }
  return files;
}

function enhanceZipInput(input) {
  if (!(input instanceof HTMLInputElement) || input.dataset.zipKnowledgeEnhanced === "1") return;
  input.dataset.zipKnowledgeEnhanced = "1";
  const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
  if (label && !label.dataset.zipKnowledgeLabel) {
    label.dataset.zipKnowledgeLabel = "1";
    const textNode = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (textNode) textNode.textContent = "选择资料（支持 MD、ZIP）";
  }
}

function refreshKnowledgeUploadUi() {
  const input = document.getElementById("document-file");
  if (input) enhanceZipInput(input);
  for (const hint of document.querySelectorAll(".admin-form-help, .field-help, small")) {
    const text = hint.textContent || "";
    if (/TXT|Markdown|PDF|JPG|PNG|WebP/u.test(text) && !hint.dataset.zipKnowledgeHint) {
      hint.dataset.zipKnowledgeHint = "1";
      hint.textContent = "支持 MD、ZIP。纯文字资料使用 MD；包含图片的资料使用 ZIP（Markdown + assets）。";
    }
  }
}

window.unpackKnowledgeZip = unpackKnowledgeZip;
const observer = new MutationObserver(refreshKnowledgeUploadUi);
observer.observe(document.documentElement, { childList: true, subtree: true });
refreshKnowledgeUploadUi();
