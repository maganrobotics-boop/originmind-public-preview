import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZFEAAAAASUVORK5CYII=", "base64");
const script = await readFile(new URL("../public/zip-import-addon.js", import.meta.url), "utf8");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(value);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...local, central, end])], "实验平台.zip", { type: "application/zip" });
}

function unpacker() {
  const context = {
    window: {}, File, Blob, TextDecoder, TextEncoder, DecompressionStream, Response,
    HTMLInputElement: class {},
    MutationObserver: class { observe() {} },
    document: { documentElement: {}, getElementById: () => null, querySelectorAll: () => [] },
  };
  runInNewContext(script, context, { timeout: 1000 });
  return context.window.unpackKnowledgeZip;
}

test("built browser ZIP importer preserves original bytes referenced by Word/Pandoc HTML", async () => {
  const markdown = '<img src="assets/image31.png" style="width:4.18557in;height:2.3in" alt="差速轮式小车正视与侧视" />';
  const files = await unpacker()(storedZip([["index.md", markdown], ["assets/image31.png", png]]));
  assert.deepEqual(Array.from(files, file => file.name), ["index.md", "assets/image31.png"]);
  assert.equal(files[1].type, "image/png");
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), png);
  assert.equal(await files[0].text(), markdown);
});

test("mixed image forms keep both files, deduplicate repeats, and omit unrelated ZIP assets", async () => {
  const markdown = '<img src="assets/front.png" alt="正视图">\n![侧视图](assets/side.png)\n<img src="assets/front.png">';
  const files = await unpacker()(storedZip([
    ["index.md", markdown], ["assets/front.png", png], ["assets/side.png", png], ["assets/unrelated.png", png],
  ]));
  assert.deepEqual(Array.from(files, file => file.name), ["index.md", "assets/front.png", "assets/side.png"]);
});

test("missing HTML image fails visibly instead of silently importing only Markdown", async () => {
  await assert.rejects(unpacker()(storedZip([["index.md", '<img src="assets/missing.png" alt="缺失图">']])),
    /index.md 引用了缺失图片：assets\/missing\.png/u);
});

test("the generated classic-script helper embeds the exact shared OA reference parser", async () => {
  const shared = await readFile(new URL("../lib/knowledge-image-references.mjs", import.meta.url), "utf8");
  assert(script.includes(shared.replace("export function knowledgeImageReferences", "function knowledgeImageReferences")));
  assert.doesNotMatch(script, /^\s*(?:import|export)\s/mu);
});
