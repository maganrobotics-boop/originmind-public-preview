// Run on an isolated checkout with PLAYWRIGHT_MODULE pointing to playwright's
// installed index.mjs. All APIs are intercepted; no production writes occur.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.PLAYWRIGHT_MODULE) throw Error("Set PLAYWRIGHT_MODULE to the installed playwright/index.mjs");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || "answer-browser-report");
await mkdir(output, {recursive: true});
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(resolve(root) + sep)) throw Error("invalid path");
    const bytes = await readFile(path);
    res.setHeader("Content-Type", ({".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".webmanifest":"application/manifest+json"})[extname(path)] || "application/octet-stream");
    res.end(bytes);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true});
const answer = String.raw`## 机器人运动模型

**核心结论：**速度与转弯半径共同影响运动状态；关键关系为 \(a=\frac{v^2}{r}\)。

### 状态矩阵

\[
A=\begin{bmatrix}1&2\\3&4\end{bmatrix},\quad x[999]=\sum_{i=1}^{n}x_i
\]

| **指标** | **表达式** |
| :--- | ---: |
| 范数 | $|x|$ |
| 误差 | $e_i^2$ |

1. **确认参数**，保留单位。
2. **复核结果**，结合实机测试。

**完整结尾**。`;
const ready = {storageReady:true,modelReady:true,qwenReady:true,oaReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true,systemReady:true};
try {
  for (const [name, viewport] of [["desktop",{width:1280,height:900}], ["mobile",{width:390,height:844}]]) {
    const context = await browser.newContext({viewport,serviceWorkers:"block"});
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      await route.fulfill({json: pathname === "/api/chat" ? {answer, mode:"ai", provider:"test", oaPublicStatus:"connected", images:[]} : pathname === "/api/status" ? ready : pathname === "/api/suggestions" ? {suggestions:[]} : {ok:true}});
    });
    await page.goto(origin);
    const input = page.locator("textarea").first();
    await input.fill("请解释机器人运动模型和矩阵");
    await input.press("Enter");
    await page.locator('.message.assistant [data-math-status="rendered"]').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant [data-math-status="rendered"]').length === 4);
    assert.equal(await page.locator(".message.assistant math").count(),4);
    assert.ok(await page.locator(".message.assistant strong").count() >= 5);
    assert.equal(await page.locator(".further-inquiry").count(),0);
    assert.equal(await page.locator(".copy-answer").count(),1);
    assert.ok((await page.locator(".message.assistant").innerText()).includes("完整结尾"));
    assert.equal(await page.locator(".message.assistant .answer-content strong").first().evaluate(node=>getComputedStyle(node).fontWeight),"700");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path:resolve(output,`${name}.png`),fullPage:true});
    // History restoration must render formulas again, without recreating a CTA.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant math').length === 4);
    assert.equal(await page.locator(".further-inquiry").count(),0);
    assert.deepEqual(errors, []);
    console.log(`${name}: real chat submission, 4 MathML formulas, bold/table/footer, width and reload checks passed`);
    await context.close();
  }
  const context = await browser.newContext({serviceWorkers:"block"});
  const page = await context.newPage();
  await page.route("**/assets/katex-*.mjs*", route => route.abort());
  await page.route("**/api/**", route => route.fulfill({json: new URL(route.request().url()).pathname === "/api/chat" ? {answer,mode:"ai",images:[]} : ready}));
  await page.goto(origin);
  await page.locator("textarea").first().fill("公式组件故障测试");
  await page.locator("textarea").first().press("Enter");
  await page.locator('[data-math-status="fallback"]').first().waitFor();
  assert.ok((await page.locator(".message.assistant").innerText()).includes("完整结尾"));
  assert.equal(await page.locator(".copy-answer").count(),1);
  console.log("dependency unavailable: original formulas, complete prose and copy remain usable");
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
