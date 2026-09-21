// Isolated real browser rendering; every API is intercepted, no production writes.
import assert from "node:assert/strict";
import { fallbackAnswer } from "../src/knowledge.mjs";
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
const markdown = "# 示例机器人公司\n\n## 公司介绍\n\n**主要方向**是自主导航与机器人系统。\n\n| 场景 | 用途 |\n| --- | --- |\n| 金属矿 | 巡检 |\n| 工厂 | 运输 |";
const cases = [
  ["structured-answer", markdown],
  ["failed-prose-synthesis", fallbackAnswer([{title:"示例机器人公司",body:markdown}])],
  ["legacy-collapsed", "公司从事机器人研发。 ## 功能介绍\n\n| 场景 | 功能 | |---|---| | 金属矿 | 巡检 | | 工厂 | 运输 |\n\n[公司主页](https://example.test/company)"],
  ["failed-slide-synthesis", fallbackAnswer([{title:"示例公司",body:"## 第 1 页封面(INVESTOR BRIEF) 示例企业。 仅供投资人交流未经许可请勿转发。"}])],
];
const ready = {storageReady:true,modelReady:true,qwenReady:true,oaReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true,systemReady:true};
try {
  for(const [name,viewport] of [["desktop",{width:1280,height:900}],["tablet",{width:1024,height:1366}],["mobile",{width:390,height:844}]]) {
    for(const [scenario,answer] of cases) {
      const context=await browser.newContext({viewport,serviceWorkers:"block"});
      const page=await context.newPage();
      const errors=[]; page.on("pageerror",error=>errors.push(error.message));
      await page.route("**/api/**",async route=>{
        const pathname=new URL(route.request().url()).pathname;
        await route.fulfill({json:pathname==="/api/chat"?{answer,mode:"retrieval",images:[]}:pathname==="/api/status"?ready:pathname==="/api/suggestions"?{suggestions:[]}:{ok:true}});
      });
      await page.goto(origin);
      await page.locator("textarea").first().fill("示例机器人公司简介");
      await page.locator("textarea").first().press("Enter");
      await page.locator(".message.assistant .copy-answer").waitFor();
      for(const restored of [false,true]) {
        if(restored) { await page.reload(); await page.locator(".message.assistant .copy-answer").waitFor(); }
        const content=page.locator(".message.assistant .answer-content");
        const text=await content.innerText();
        assert.doesNotMatch(text,/##|\|---|\]\(https|INVESTOR BRIEF|仅供投资人/u);
        assert.equal(await content.locator("a,img").count(),0);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        if(!scenario.startsWith("failed-")) {
          assert.equal(await content.locator("table").count(),1);
          assert.equal(await content.locator("td").count(),4);
          assert.ok(await content.locator("p").count()>=1);
          assert.ok(await content.locator("h3,h4,h5,h6").count()>=1);
        } else assert.match(text,/未能生成完整答复/u);
        const headingSizes=await content.locator("h3,h4,h5,h6").evaluateAll(nodes=>nodes.map(node=>node.textContent.length));
        assert.ok(headingSizes.every(length=>length<=100));
      }
      assert.deepEqual(errors,[]);
      await page.screenshot({path:resolve(output,`layout-${name}-${scenario}.png`),fullPage:true});
      console.log(`${name} ${scenario}: readable paragraphs/table, no raw syntax or URL actions, width and history restoration passed`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
