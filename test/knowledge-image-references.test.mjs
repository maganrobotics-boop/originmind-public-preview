import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeImageReferences } from "../lib/knowledge-image-references.mjs";

const entries = (content) => [...knowledgeImageReferences(content)];

test("reads the production Word/Pandoc image form without exposing HTML attributes", () => {
  const html = '<img src="assets/image31.png" style="width:4.18557in;height:2.30917in" alt="差速轮式小车实验平台正视与侧视图" />';
  assert.deepEqual(entries(html), [["assets/image31.png", "差速轮式小车实验平台正视与侧视图"]]);
});

test("preserves source order and deduplicates mixed HTML and Markdown references", () => {
  assert.deepEqual(entries([
    '<img src="assets/image31.png" alt="正视图" />',
    '![侧视图](<assets/image32.webp> "实验平台")',
    '![重复图片](assets/image31.png)',
    '<IMG ALT=相机 SRC=assets/camera.jpg >',
  ].join("\n")), [
    ["assets/image31.png", "正视图"],
    ["assets/image32.webp", "侧视图"],
    ["assets/camera.jpg", "相机"],
  ]);
});

test("accepts quoted, multiline, entity-encoded and relative exported references", () => {
  assert.deepEqual(entries('<img\nalt="雷达 &amp; 相机 > 底盘"\nsrc=\'./assets/image31.png?cache=1\' />'),
    [["assets/image31.png", "雷达 & 相机 > 底盘"]]);
  assert.deepEqual(entries('<img src="assets&#47;image31.png" alt="&#x76F8;机" />'),
    [["assets/image31.png", "相机"]]);
  assert.deepEqual(entries('![图](assets%2Fimage31.png#detail)'), [["assets/image31.png", "图"]]);
});

for (const path of [
  'https://example.com/image.png', '//example.com/image.png', '/api/private/image.png',
  'javascript:alert(1)', 'data:image/png;base64,AAAA', 'assets/../private.png',
  'assets/%2e%2e/private.png', 'assets/./image.png', 'assets//image.png',
  'assets/%252e%252e/image.png', 'assets/%ZZ.png', 'assets/image.svg',
  'assets/image.html', 'other/image.png', 'assets/%00image.png',
]) {
  test(`does not turn an unsafe or unsupported image path into a capability: ${path}`, () => {
    assert.equal(knowledgeImageReferences(`<img src="${path}" alt="unsafe">`).size, 0);
  });
}

test("does not interpret data-src, duplicate attributes, or plain path mentions as images", () => {
  assert.equal(knowledgeImageReferences([
    '<img data-src="assets/image31.png">',
    '<img src="assets/a.png" SRC="assets/b.png">',
    '<img src="assets/a.png" alt="one" ALT="two">',
    '文件路径为 assets/image31.png。',
  ].join("\n")).size, 0);
});

test("ignores code samples, comments, and raw text HTML blocks", () => {
  const content = [
    '`![示例](assets/inline.png)`',
    '```html', '<img src="assets/fenced.png">', '```',
    '~~~~', '![示例](assets/tilde.png)', '~~~~',
    '<!-- <img src="assets/comment.png"> -->',
    '<pre><img src="assets/pre.png"></pre>',
    '<script>const value = \'<img src="assets/script.png">\';</script>',
    '<img src="assets/real.png" alt="实际插图">',
  ].join("\n");
  assert.deepEqual(entries(content), [["assets/real.png", "实际插图"]]);
});

test("treats all non-source attributes as inert data and supports missing alt text", () => {
  assert.deepEqual(entries('<img src="assets/image31.png" onerror="throw new Error(1)" srcset="https://example.com/x.png 2x">'),
    [["assets/image31.png", ""]]);
  assert.deepEqual(entries(null), []);
});
