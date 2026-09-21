// Isolated API fixtures exercise the real built frontend. The optional exact
// production origin checks deployed assets without model requests or writes.
// No credentials, personal history or uploads are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECURITY_HEADERS } from "../src/static-router.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw Error("Set PLAYWRIGHT_MODULE to playwright/index.mjs");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || "formula-browser-report");
await mkdir(output, {recursive:true});
const answer = await readFile(new URL("../test/fixtures/robot-dynamics-answer.md", import.meta.url), "utf8");
const report = {origin: process.env.ANSWER_BROWSER_ORIGIN || "isolated-local", tests:[]};
let server;
let browser;
const externalOrigin = process.env.ANSWER_BROWSER_ORIGIN;
if (externalOrigin && externalOrigin !== "https://chat.omindos.ai") throw Error("Unexpected browser-check origin");
let origin = externalOrigin;
if (!origin) {
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!path.startsWith(resolve(root) + sep)) throw Error("invalid path");
      const bytes = await readFile(path);
      for (const [name,value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name,value);
      res.setHeader("Content-Type", ({".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".webmanifest":"application/manifest+json"})[extname(path)] || "application/octet-stream");
      res.end(bytes);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const ready = {storageReady:true,modelReady:true,qwenReady:true,oaReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true,systemReady:true};
async function createPage(viewport={width:390,height:844}, content=answer) {
  const context = await browser.newContext({viewport,serviceWorkers:"block"});
  const page = await context.newPage();
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({json: path === "/api/chat" ? {answer:content,mode:"ai",provider:"isolated-test",oaPublicStatus:"connected",images:[]}
      : path === "/api/suggestions" ? {suggestions:[]} : ready});
  });
  return {context,page,errors};
}
async function submit(page, question="请解释机器人动力学方程与惯性矩阵") {
  await page.locator("textarea").first().fill(question);
  await page.locator("textarea").first().press("Enter");
  await page.locator(".message.assistant").first().waitFor();
}
async function expectRendered(page,count=8) {
  await page.waitForFunction(count => document.querySelectorAll('.message.assistant [data-math-status="rendered"]').length === count,count,{timeout:15000});
  assert.equal(await page.locator('.message.assistant [data-math-status="fallback"]').count(),0);
  assert.equal(await page.locator(".message.assistant math").count(),count);
  assert.equal(await page.locator(".further-inquiry").count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
}
try {
  browser = await chromium.launch({headless:true});
  for (const [name,viewport] of [["desktop",{width:1280,height:900}],["mobile",{width:390,height:844}]]) {
    const {context,page,errors} = await createPage(viewport);
    await page.goto(origin);
    await submit(page);
    await expectRendered(page);
    assert.equal(await page.locator(".answer-math-block").count(),2);
    assert.equal(await page.locator(".answer-math-block").first().locator("mfrac").count(),3);
    assert.equal(await page.locator(".answer-math-block").last().locator("mtr").count(),3);
    assert.equal(await page.locator(".answer-math-block").last().locator("mtd").count(),9);
    assert.ok(await page.locator(".message.assistant strong").count()>=5);
    assert.ok((await page.locator(".message.assistant").innerText()).includes("完整结尾"));
    assert.equal(await page.locator(".copy-answer").count(),1);
    await page.locator(".message.assistant").screenshot({path:resolve(output,`${name}-formulas.png`)});
    await page.reload();
    await expectRendered(page);
    assert.equal(await page.locator(".copy-answer").count(),1);
    assert.deepEqual(errors,[]);
    report.tests.push({name,passed:true,formulas:8,matrixRows:3,matrixCells:9,historyReload:true});
    await context.close();
  }
  {
    const slash=String.fromCharCode(92);
    const damaged=answer.split(slash+slash+"\n").join(slash+"\n");
    assert.notEqual(damaged,answer);
    const {context,page,errors} = await createPage(undefined,damaged);
    await page.goto(origin); await submit(page); await expectRendered(page);
    assert.equal(await page.locator(".answer-math-block").last().locator("mtr").count(),3);
    assert.equal(await page.locator(".answer-math-block").last().locator("mtd").count(),9);
    assert.deepEqual(errors,[]);
    report.tests.push({name:"single-backslash-matrix",passed:true,matrixRows:3,matrixCells:9});
    await context.close();
  }
  {
    const {context,page,errors} = await createPage();
    let requests=0;
    await page.route("**/assets/katex-*.mjs*", route => ++requests===1 ? route.abort() : route.continue());
    await page.goto(origin); await submit(page); await expectRendered(page);
    assert.equal(requests,2);
    assert.deepEqual(errors,[]);
    report.tests.push({name:"transient-engine-load",passed:true,requests});
    await context.close();
  }
  {
    const {context,page,errors} = await createPage();
    let requests=0;
    const pattern="**/assets/katex-*.mjs*";
    const fail = route => {requests++;return route.abort();};
    await page.route(pattern,fail);
    await page.goto(origin); await submit(page);
    await page.waitForFunction(()=>document.querySelectorAll('[data-math-status="fallback"]').length===8);
    assert.equal(requests,3);
    assert.ok((await page.locator(".message.assistant").innerText()).includes("完整结尾"));
    assert.equal(await page.locator(".copy-answer").count(),1);
    await page.unroute(pattern,fail);
    await submit(page,"网络恢复后重新解释公式");
    await expectRendered(page,16);
    assert.deepEqual(errors,[]);
    report.tests.push({name:"permanent-failure-and-later-recovery",passed:true,boundedRequests:requests});
    await context.close();
  }
  report.passed=true;
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  report.passed=false; report.error=String(error); throw error;
} finally {
  await writeFile(resolve(output,"results.json"),JSON.stringify(report,null,2));
  if(browser) await browser.close();
  if(server) await new Promise(resolve=>server.close(resolve));
}
