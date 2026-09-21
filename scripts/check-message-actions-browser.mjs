// Desktop/mobile regression checks; APIs and clipboard/share are isolated test doubles.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (!process.env.PLAYWRIGHT_MODULE) throw Error('Set PLAYWRIGHT_MODULE');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || 'message-actions-browser-report');
await mkdir(output, { recursive:true });
const server = createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(resolve(root) + sep)) throw Error('invalid path');
    const bytes = await readFile(path);
    res.setHeader('Content-Type', ({ '.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png' })[extname(path)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404);res.end('not found'); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true });
const answer = String.raw`## 机器人运动模型

**核心结论：**这是完整回答。公式为 $a=\frac{v^2}{r}$。

最后一段完整保留。`;
const ready = { storageReady:true,modelReady:true,qwenReady:true,oaReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true,systemReady:true };
async function instrument(page, requests) {
  await page.addInitScript(() => {
    window.__copied = [];window.__shared = [];
    Object.defineProperty(navigator,'clipboard',{ configurable:true,value:{ writeText:async text => { window.__copied.push(text); } } });
    Object.defineProperty(navigator,'share',{ configurable:true,value:async data => { window.__shared.push(data); } });
  });
  await page.route('**/api/**',async route => {
    const pathname = new URL(route.request().url()).pathname;
    let json = { ok:true };
    if (pathname === '/api/chat') {
      const body = route.request().postDataJSON();requests.push(body);
      const noSource = body.messages.at(-1).content.includes('未引用资料');
      json = { answer, mode:'ai', provider:'test', oaPublicStatus:'connected', images:[], sources:noSource ? [] : [{ id:'approved',title:'approved public material' }], conversationToken:'signed-private-test-token' };
    } else if (pathname === '/api/shares' && route.request().method() === 'POST') {
      json = { id:'0123456789abcdef' };
    } else if (pathname === '/api/shares/0123456789abcdef') {
      json = { v:1, question:'请介绍机器人运动模型', answer };
    } else if (pathname === '/api/status') json = ready;
    else if (pathname === '/api/suggestions') json = { suggestions:[] };
    await route.fulfill({ json });
  });
}
try {
  for (const [name,viewport] of [['desktop',{width:1280,height:900}],['mobile',{width:390,height:844}]]) {
    const context = await browser.newContext({ viewport, hasTouch:name === 'mobile', isMobile:name === 'mobile',serviceWorkers:'block' });
    const page = await context.newPage();const requests = [];const errors=[];
    page.on('pageerror',error=>errors.push(error.message));await instrument(page,requests);
    try {
    await page.goto(origin);
    const input = page.getByRole('textbox',{name:'你的问题',exact:true});
    await input.fill('请介绍机器人运动模型');await input.press('Enter');
    await page.locator('.message.assistant math').first().waitFor();
    const toolbar = page.locator('.message.assistant .message-actions').last();
    assert.deepEqual(await toolbar.locator('button').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['复制回答','复制链接','分享链接']);
    assert.equal(await toolbar.locator('.message-source-note').innerText(),'参考内部公开资料');
    assert.equal(await toolbar.evaluate(node=>getComputedStyle(node).justifyContent),'flex-start');
    await toolbar.locator('.copy-answer').click();
    assert.ok((await page.evaluate(()=>window.__copied.at(-1))).includes('最后一段完整保留'));
    assert.ok(!(await page.evaluate(()=>window.__copied.at(-1))).includes('参考内部公开资料'));
    // Copy-link shows only the selected pair, and requires explicit approval.
    await toolbar.locator('.copy-answer-link').click();
    const shareDialog = page.locator('.message-action-dialog');
    await shareDialog.getByRole('button',{name:'确认并复制链接',exact:true}).click();
    await page.waitForFunction(()=>window.__copied.at(-1)?.includes('?share='));
    const link = await page.evaluate(()=>window.__copied.at(-1));
    assert.equal(new URL(link).search,'?share=0123456789abcdef');
    assert.equal(new URL(link).hash,'');
    await shareDialog.getByRole('button',{name:'关闭',exact:true}).click();
    // A fresh browser opens the exact snapshot without sending or restoring anyone's chat.
    const fresh = await browser.newContext({ viewport,serviceWorkers:'block' });
    const recipient = await fresh.newPage();const incomingRequests=[];await instrument(recipient,incomingRequests);
    await recipient.goto(link);
    await recipient.locator('.answer-share-preview .answer-content').waitFor();
    assert.ok((await recipient.locator('.answer-share-preview').innerText()).includes('最后一段完整保留'));
    assert.equal(incomingRequests.length,0);assert.equal(await recipient.locator('.message.user').count(),0);
    assert.equal(new URL(recipient.url()).search,'');
    assert.equal(new URL(recipient.url()).hash,'');
    await recipient.screenshot({path:resolve(output,`message-share-${name}.png`),fullPage:true,animations:'disabled'});await fresh.close();
    await toolbar.locator('.share-answer').click();
    await page.getByRole('button',{name:'确认并分享',exact:true}).click();
    await page.waitForFunction(()=>window.__shared.length === 1);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('.message-action-dialog').waitFor({state:'detached'});
    // Copy and cancel editing do not mutate the original conversation.
    await page.locator('.question-actions-trigger').first().click();
    await page.getByRole('button',{name:'复制',exact:true}).click();
    await page.waitForFunction(()=>window.__copied.at(-1) === '请介绍机器人运动模型');
    await page.locator('.question-actions-trigger').first().click();
    await page.getByRole('button',{name:'修改',exact:true}).click();
    await page.getByRole('textbox',{name:'修改提问内容'}).fill('取消的修改');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.message-action-dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('.message.user .message-body').first().innerText(),'请介绍机器人运动模型');
    assert.equal(requests.length,1);
    await page.locator('.question-actions-trigger').first().click();
    await page.getByRole('button',{name:'修改',exact:true}).click();
    await page.getByRole('textbox',{name:'修改提问内容'}).fill('修改后的机器人问题');
    await page.getByRole('button',{name:'保存并重新回答',exact:true}).click();
    await page.locator('.message-action-dialog').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector('.message.user .message-body')?.textContent === '修改后的机器人问题');
    await page.locator('.message.assistant math').first().waitFor();
    assert.equal(requests.length,2);assert.equal(requests[1].conversationToken,undefined);
    assert.equal(requests[1].messages.at(-1).content,'修改后的机器人问题');
    // On mobile the recent list is inside a closed dialog. Exercise its real entry
    // point rather than weakening the assertion by including hidden elements.
    async function restoreRecentQuestion(question) {
      if (name === 'mobile') {
        await page.getByRole('button',{name:'打开主题菜单',exact:true}).click();
        await page.locator('#topic-drawer[open]').waitFor();
      }
      const sidebar = page.locator(name === 'mobile' ? '#topic-drawer' : '.chat-sidebar');
      const entry = sidebar.getByRole('button',{name:new RegExp(`^${question}，`)});
      await entry.waitFor({state:'visible'});
      assert.equal(await entry.count(),1);
      await entry.click();
      await page.waitForFunction(expected => document.querySelector('.message.user .message-body')?.textContent === expected, question);
      await page.locator('.message.assistant math').first().waitFor();
      if (name === 'mobile') assert.equal(await page.locator('#topic-drawer[open]').count(),0);
    }
    await restoreRecentQuestion('请介绍机器人运动模型');
    assert.equal(await page.locator('.message.user').count(),1);
    assert.ok((await page.locator('.message.assistant .answer-content').innerText()).includes('最后一段完整保留'));
    await restoreRecentQuestion('修改后的机器人问题');
    assert.equal(requests.length,2,'Restoring either saved conversation must not request another answer');
    await page.reload();await page.locator('.message.assistant math').first().waitFor();
    assert.equal(await page.locator('.message-source-note').count(),1);
    // Reproduce a fast close-to-composer handoff in one browser task. A queued
    // close listener must not steal focus back before the next Enter key.
    await page.locator('.question-actions-trigger').first().click();
    await page.evaluate(() => {
      document.querySelector('.question-action-menu').close();
      document.querySelector('#question').focus();
    });
    await page.locator('.question-action-menu').waitFor({state:'detached'});
    assert.equal(await input.evaluate(node => document.activeElement === node),true);
    // Movement cancels long-press; a stationary touch opens the same accessible menu.
    const bubble = page.locator('.message.user .message-body').first();
    await bubble.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:50,clientY:60});
    await bubble.dispatchEvent('pointermove',{pointerType:'touch',clientX:50,clientY:95});
    await page.waitForTimeout(550);await bubble.dispatchEvent('pointerup',{pointerType:'touch'});
    assert.equal(await page.locator('.question-action-menu').count(),0);
    await bubble.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:50,clientY:60});
    await page.locator('.question-action-menu').waitFor();await bubble.dispatchEvent('pointerup',{pointerType:'touch'});
    await page.keyboard.press('Escape');
    await page.locator('.question-action-menu').waitFor({state:'detached'});
    await page.locator('.message.user').first().focus();await page.keyboard.press('Shift+F10');
    await page.locator('.question-action-menu').waitFor();await page.keyboard.press('Escape');
    await page.locator('.question-action-menu').waitFor({state:'detached'});
    await input.fill('未引用资料时不要标注来源');
    await input.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length === 2);
    assert.equal(requests.length,3);
    assert.equal(requests[2].messages.at(-1).content,'未引用资料时不要标注来源');
    assert.equal(await page.locator('.message.assistant').last().locator('.message-source-note').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path:resolve(output,`message-actions-${name}.png`),fullPage:true,animations:'disabled'});
    assert.deepEqual(errors,[]);
    console.log(`${name}: copy/copy-link/native-share/source evidence, fresh share view, edit cancel/fork/token reset, original and edited history restore, dialog focus handoff, reload, long-press cancellation, keyboard and width passed`);
    } catch (error) {
      // Only fixture content and stubbed request counts are recorded here.
      const diagnostic = await page.evaluate(() => ({
        text: document.body.innerText, active: document.activeElement?.outerHTML,
        dialogs: Array.from(document.querySelectorAll('dialog')).map(node => ({label:node.getAttribute('aria-label'),open:node.open})),
      })).catch(() => ({}));
      await writeFile(resolve(output,`message-actions-${name}-failure.json`),JSON.stringify({requestCount:requests.length,errors,...diagnostic},null,2));
      await page.screenshot({path:resolve(output,`message-actions-${name}-failure.png`),fullPage:true,animations:'disabled'}).catch(() => {});
      console.error(`${name}: ${requests.length} fixture chat requests; browser errors: ${JSON.stringify(errors)}; active: ${diagnostic.active}`);
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }

