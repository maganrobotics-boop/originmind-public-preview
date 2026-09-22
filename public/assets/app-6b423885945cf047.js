// Message actions. Bundled locally; no third-party sharing service or transcript upload.
const ANSWER_SHARE_PREFIX = '#answer=';
const ANSWER_SHARE_MAX_BYTES = 262144;
const ANSWER_SHARE_MAX_LINK = 60000;

function answerSnapshot(value) {
  if (!value || value.v !== 1 || typeof value.answer !== 'string' ||
      !value.answer.trim() || typeof value.question !== 'string' || value.question.length > 2000) {
    throw new Error('分享链接内容不正确。');
  }
  // Explicit allowlist: never retain a conversation token, sources, user data or history.
  const snapshot = { v: 1, question: value.question, answer: value.answer };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > ANSWER_SHARE_MAX_BYTES) {
    throw new Error('这条回答过长，请使用“复制”分享全文。');
  }
  return snapshot;
}

function answerShareBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function boundedShareStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > ANSWER_SHARE_MAX_BYTES) {
        await reader.cancel();
        throw new Error('分享链接内容过长。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function createAnswerShareUrl(value, origin) {
  const snapshot = answerSnapshot(value);
  if (typeof fetch === 'function') {
    const response = await fetch('/api/shares', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: snapshot.question, answer: snapshot.answer }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.id !== 'string' || !/^[a-f0-9]{16}$/.test(data.id)) throw new Error(data.error || '短链接生成失败，请稍后重试。');
    const base = new URL('/', origin);
    if (!/^https?:$/.test(base.protocol)) throw new Error('分享地址不正确。');
    base.searchParams.set('share', data.id);
    return base.href;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  let encoding = 'text';
  let payload = bytes;
  if (typeof CompressionStream === 'function') {
    try {
      const compressed = await boundedShareStream(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
      if (compressed.length < bytes.length) { encoding = 'gzip'; payload = compressed; }
    } catch { /* Older browsers use the lossless plain-text format. */ }
  }
  const base = new URL('/', origin);
  if (!/^https?:$/.test(base.protocol)) throw new Error('分享地址不正确。');
  base.hash = `answer=1.${encoding}.${answerShareBase64(payload)}`;
  if (base.href.length > ANSWER_SHARE_MAX_LINK) throw new Error('这条回答的链接过长，请使用“复制”分享全文。');
  return base.href;
}

async function decodeAnswerShare(hash) {
  if (typeof hash !== 'string' || hash.length > ANSWER_SHARE_MAX_LINK) throw new Error('分享链接过长或不完整。');
  const match = /^#answer=1\.(text|gzip)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new Error('分享链接不完整或版本不受支持。');
  const binary = atob(match[2].replace(/-/g, '+').replace(/_/g, '/'));
  let bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (match[1] === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器无法打开压缩分享，请换用较新的浏览器。');
    bytes = await boundedShareStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  }
  return answerSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

async function writeMessageClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Clipboard permissions may be denied; try the focused-page fallback. */ }
  const previous = document.activeElement;
  const selection = window.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const probe = document.createElement('textarea');
  probe.className = 'message-copy-probe';
  probe.value = text;
  probe.setAttribute('aria-label', '复制内容');
  (document.querySelector('dialog[open]') || document.body).append(probe);
  try {
    probe.focus({ preventScroll: true });
    probe.select();
    if (!document.execCommand?.('copy')) throw new Error('无法自动复制，请长按选择文字。');
  } finally {
    probe.remove();
    previous?.focus?.({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

function messageActionIcon(name) {
  const paths = {
    copy: ['M9 9h11v12H9z', 'M5 16H3V3h12v2'],
    link: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'],
    share: ['M12 16V3m-4 4 4-4 4 4', 'M5 12v8h14v-8'],
    edit: ['m16 3 5 5-12 12-6 1 1-6Z', 'm13 6 5 5'],
    more: ['M5 12h.01M12 12h.01M19 12h.01'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  for (const d of paths[name] || paths.more) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}

function messageActionButton(label, iconName, className, action) {
  const button = textButton('', `message-action-button ${className || ''}`);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(messageActionIcon(iconName));
  button.addEventListener('click', action);
  return button;
}

function messageActionDialog(title, opener) {
  const dialog = element('dialog', { className: 'message-action-dialog', attributes: { 'aria-label': title } });
  const heading = element('h2', { text: title });
  const close = textButton('关闭', 'message-dialog-close');
  close.addEventListener('click', () => dialog.close());
  const header = element('header', { className: 'message-dialog-header' }, [heading, close]);
  dialog.append(header);
  dialog.addEventListener('close', () => {
    // The close event is queued: another field or dialog may already own focus.
    const active = document.activeElement;
    const unclaimed = !active || active === document.body || dialog.contains(active);
    dialog.remove();
    if (unclaimed && !document.querySelector('dialog[open]') && opener?.isConnected) {
      opener.focus({ preventScroll: true });
    }
  }, { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  } });
  document.body.append(dialog);
  return dialog;
}

function answerSharePreview(dialog, snapshot) {
  const preview = element('section', { className: 'answer-share-preview' });
  if (snapshot.question) preview.append(element('h3', { text: '问题' }), element('p', { className: 'shared-question', text: snapshot.question }));
  preview.append(element('h3', { text: '回答' }), renderAnswerBody(snapshot.answer));
  dialog.append(preview);
}

function openAnswerShare(snapshot, opener, intent = 'copy') {
  const dialog = messageActionDialog('分享这条问答', opener);
  dialog.append(element('p', { className: 'message-dialog-note', text: '仅分享预览中的这一问一答，不包含其他聊天或登录信息。任何获得链接的人都能查看；链接不能撤回，请先确认没有个人或非公开信息。' }));
  answerSharePreview(dialog, snapshot);
  const status = element('p', { className: 'message-share-status', attributes: { role: 'status', 'aria-live': 'polite' }, text: '正在生成链接…' });
  const actions = element('div', { className: 'message-dialog-actions' });
  const copy = textButton('确认并复制链接', 'primary-button');
  const share = textButton('确认并分享', 'secondary-button');
  copy.disabled = true; share.disabled = true;
  actions.append(copy, share); dialog.append(status, actions); dialog.showModal();
  // Build locally, then use a second user gesture to preserve native-share activation.
  void createAnswerShareUrl(snapshot, window.location.origin).then(url => {
    if (!dialog.isConnected) return;
    status.textContent = '短链接已生成，有效期 30 天。';
    copy.disabled = false; share.disabled = false;
    copy.addEventListener('click', async () => {
      try { await writeMessageClipboard(url); status.textContent = '分享链接已复制'; }
      catch (error) { status.textContent = error.message; }
    });
    share.addEventListener('click', async () => {
      try {
        if (typeof navigator.share === 'function') {
          await navigator.share({ title: 'ARTS Robotics 问答分享', url });
          status.textContent = '已调用系统分享';
        } else { await writeMessageClipboard(url); status.textContent = '当前浏览器未提供系统分享，链接已复制'; }
      } catch (error) {
        status.textContent = error?.name === 'AbortError' ? '已取消分享' : '分享未完成，请点击“确认并复制链接”。';
      }
    });
    (intent === 'share' ? share : copy).focus({ preventScroll: true });
  }).catch(error => { if (dialog.isConnected) status.textContent = error.message; });
}

function openQuestionEditor(question, opener, onSubmit) {
  const dialog = messageActionDialog('修改提问', opener);
  dialog.append(element('p', { className: 'message-dialog-note', text: '修改后从此处重新回答；原聊天保留在最近聊天中。取消不会改变已有内容。' }));
  const form = element('form', { className: 'message-edit-form' });
  const input = element('textarea', { className: 'message-edit-input', attributes: { 'aria-label': '修改提问内容', maxlength: '2000', required: true, rows: '5' } });
  input.value = question;
  const status = element('p', { attributes: { role: 'alert' } });
  const actions = element('div', { className: 'message-dialog-actions' });
  const cancel = textButton('取消', 'secondary-button');
  cancel.addEventListener('click', () => dialog.close());
  const submit = textButton('保存并重新回答', 'primary-button'); submit.type = 'submit';
  actions.append(cancel, submit); form.append(input, status, actions); dialog.append(form);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || text.length > 2000) { status.textContent = '请输入 1–2000 字的问题。'; return; }
    try { onSubmit(text); dialog.close(); } catch (error) { status.textContent = error.message; }
  });
  dialog.showModal(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}

function installQuestionActions(article, question, onEdit, onCopy) {
  const row = element('div', { className: 'question-actions' });
  let opening = false;
  const open = () => {
    if (opening || !article.isConnected) return;
    opening = true;
    const dialog = messageActionDialog('提问操作', trigger);
    dialog.classList.add('question-action-menu');
    dialog.addEventListener('close', () => { opening = false; });
    const copy = textButton('复制', 'question-menu-item');
    const edit = textButton('修改', 'question-menu-item');
    copy.addEventListener('click', () => { dialog.close(); void onCopy(); });
    edit.addEventListener('click', () => { dialog.close(); onEdit(trigger); });
    dialog.append(copy, edit); dialog.showModal(); copy.focus();
  };
  const trigger = messageActionButton('提问操作：复制或修改', 'more', 'question-actions-trigger', open);
  trigger.setAttribute('aria-haspopup', 'dialog');
  row.append(trigger); article.append(row); article.tabIndex = 0;
  let timer = null; let origin = null;
  const cancel = () => { if (timer !== null) window.clearTimeout(timer); timer = null; origin = null; };
  article.addEventListener('pointerdown', event => {
    cancel();
    if (event.pointerType === 'mouse' || event.isPrimary === false || event.target.closest('button, a, input, textarea')) return;
    origin = { x: event.clientX, y: event.clientY };
    timer = window.setTimeout(() => { cancel(); window.getSelection?.()?.removeAllRanges(); open(); }, 500);
  }, { passive: true });
  article.addEventListener('pointermove', event => { if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel(); }, { passive: true });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) article.addEventListener(name, cancel, { passive: true });
  article.addEventListener('contextmenu', event => { if (event.target.closest('button, a, textarea')) return; event.preventDefault(); cancel(); open(); });
  article.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); cancel(); open(); } });
}

async function openIncomingSharedAnswer() {
  const shareId = new URLSearchParams(window.location.search).get('share');
  if (window.location.pathname === '/manage' || (!window.location.hash.startsWith(ANSWER_SHARE_PREFIX) && !shareId)) return;
  const hash = window.location.hash;
  // Consume the fragment before rendering or loading any optional answer content.
  window.history.replaceState(window.history.state, '', window.location.pathname);
  const dialog = messageActionDialog('用户分享的问答', null);
  dialog.append(element('p', { className: 'message-dialog-note', text: '这是分享者提供的文字快照，未经独立核验，不代表新的官方确认；不会自动提问或保存到你的聊天记录。' }));
  const status = element('p', { text: '正在读取分享…', attributes: { role: 'status' } });
  dialog.append(status); dialog.showModal();
  try {
    const snapshot = shareId
      ? answerSnapshot(await fetch(`/api/shares/${encodeURIComponent(shareId)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '分享链接无法读取。'); return data; }))
      : await decodeAnswerShare(hash);
    if (!dialog.isConnected) return;
    status.remove(); answerSharePreview(dialog, snapshot);
  } catch (error) { if (dialog.isConnected) status.textContent = error.message || '分享链接无法读取。'; }
}

"use strict";

const KATEX_ASSET = "/assets/katex-cc567bec51ade0dc.mjs";
void KATEX_ASSET;

const STORAGE_KEY = "originmind-public-preview-conversations-v1";
const DEFAULT_PUBLIC_API_BASE = "https://chat.omindos.ai";
const PUBLIC_API_BASE = typeof window.PUBLIC_API_BASE === "string" && window.PUBLIC_API_BASE.trim()
  ? window.PUBLIC_API_BASE.replace(/\/+$/u, "")
  : DEFAULT_PUBLIC_API_BASE;
const DEFAULT_SUGGESTIONS = [
  "实验室现有的机器人平台包括哪些？",
  "介绍实验室当前的主要研究方向",
  "实验室有哪些代表性成果与应用？",
  "如何与实验室开展科研合作？",
];
const HISTORY_ITEMS = [
  ["overview", "实验室主要研究什么？"],
  ["robots", "现有机器人平台"],
  ["cooperation", "科研合作方式"],
];
const MODE_COPY = {
  text: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "输入想了解的实验室问题", "文本模型"],
  voice: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "说出想了解的实验室问题", "语音模型"],
  vision: ["想了解实验室的什么？", "从已审核的实验室公开知识中检索并回答", "上传图片或描述需要识别的内容", "视觉模型"],
};

function apiUrl(path) {
  return `${PUBLIC_API_BASE}${path}`;
}

const icons = {
  chat: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5h14v11H9l-4 3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5h14v11H9l-4 3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  voice: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M6.5 11.5a5.5 5.5 0 0011 0M12 17v4M9 21h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  vision: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="m7 16 3.5-4 2.6 3 1.7-2 2.2 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="1" fill="currentColor"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h9l4 4v14H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="currentColor" stroke-width="1.5"/><path d="M15 3v5h5M8 12h8M8 16h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none"><path d="m4 17 10-10 3 3L7 20H4v-3zM13 8l3 3m2-7 2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" fill="none"><path d="M8.5 12.5l5.8-5.8a3 3 0 114.2 4.2l-7.9 7.9a5 5 0 11-7.1-7.1l8.2-8.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 18V6m0 0-4 4m4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" stroke="currentColor" stroke-width="1.5"/><path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none"><path d="m14 8-4 4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    output.push(`<ol>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
    list = [];
  };
  const tableRows = (start) => {
    const rows = [];
    let index = start;
    while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index])) {
      rows.push(lines[index].trim());
      index += 1;
    }
    return { rows, next: index };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) { flushParagraph(); flushList(); output.push(`<h3>${inline(heading[2])}</h3>`); continue; }
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/u);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[index + 1] || "")) {
      flushParagraph(); flushList();
      const table = tableRows(index);
      const rows = table.rows.filter((_, rowIndex) => rowIndex !== 1).map((row) => row.replace(/^\||\|$/gu, "").split("|").map((cell) => inline(cell.trim())));
      const [head = [], ...body] = rows;
      output.push(`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      index = table.next - 1;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return output.join("") || "<p>暂无内容。</p>";
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function knowledgeImageUrl(value) {
  const url = String(value || "");
  if (!/^\/api\/knowledge\/assets\/[A-Za-z0-9_-]+$/u.test(url)) return "";
  return apiUrl(url);
}

function renderKnowledgeImages(images) {
  const safeImages = (Array.isArray(images) ? images : [])
    .map((image) => ({
      url: knowledgeImageUrl(image?.url),
      alt: String(image?.alt || "资料图片").slice(0, 120),
    }))
    .filter((image) => image.url)
    .slice(0, 4);
  if (!safeImages.length) return "";
  return `<div class="knowledge-gallery">${safeImages.map((image) => `<figure class="knowledge-image"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy" decoding="async"><figcaption>${escapeHtml(image.alt)}</figcaption></figure>`).join("")}</div>`;
}

function appShell() {
  return `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-symbol"></div><div class="brand-copy"><strong class="brand-title">实验室大模型</strong><span class="brand-subtitle">ARTS Robotics</span></div></div>
      <div class="sidebar-label">置顶</div>
      <div class="nav-list">
        <button class="nav-item model-nav-item active" type="button" data-mode="text">${icons.text}<span>文本模型</span></button>
        <button class="nav-item model-nav-item" type="button" data-mode="voice">${icons.voice}<span>语音模型</span></button>
        <button class="nav-item model-nav-item" type="button" data-mode="vision">${icons.vision}<span>视觉模型</span></button>
      </div>
      <div class="sidebar-label history-label">历史</div>
      <div class="history-list">${HISTORY_ITEMS.map(([key, label]) => `<button class="history-item" type="button" data-history="${key}">${icons.chat}<span>${label}</span></button>`).join("")}</div>
      <button class="collapse-handle" type="button" aria-label="收起侧边栏">${icons.chevron}</button>
      <div class="side-footer"><div class="bottom-actions"><button class="new-chat-bottom" type="button">${icons.plus}<span>聊天</span></button><button class="settings-trigger" type="button" aria-label="设置">${icons.gear}</button></div></div>
    </aside>
    <main class="workspace"><header class="topbar"><div class="topbar-title">聊天</div></header>
      <section class="chat-surface"><div class="empty-state"><h1 class="hero-title">想了解实验室的什么？</h1><p class="hero-subtitle">从已审核的实验室公开知识中检索并回答</p></div>
        <div class="conversation" aria-live="polite"><div class="message-list"></div></div>
        <div class="composer-wrap"><div class="composer-glow"></div><form class="composer" aria-label="发送消息"><div class="composer-inner"><div class="input-panel"><textarea class="prompt-input" rows="2" maxlength="4000" placeholder="输入想了解的实验室问题"></textarea><div class="attachment-chip">${icons.paperclip}<span></span></div></div><div class="composer-footer"><div class="input-tools"><input class="file-input" type="file" hidden><button class="icon-button attach-button" type="button" aria-label="添加附件">${icons.paperclip}</button><button class="icon-button voice-button" type="button" aria-label="语音输入">${icons.voice}</button></div><div class="footer-actions"><button class="model-pill" type="button">${icons.cube}<span>文本模型</span></button><button class="send-button" type="submit" aria-label="发送" disabled>${icons.send}</button></div></div></div></form></div>
        <div class="suggestions">${DEFAULT_SUGGESTIONS.map((question, index) => `<button class="suggestion" type="button" data-prompt="${escapeHtml(question)}">${[icons.file, icons.text, icons.chart, icons.pen][index] || icons.chat}<span>${escapeHtml(question.replace(/[？?]$/u, ""))}</span></button>`).join("")}</div>
      </section></main>
  </div><div class="toast" role="status" aria-live="polite"></div>`;
}

document.getElementById("app").innerHTML = appShell();

const body = document.body;
const form = document.querySelector(".composer");
const promptInput = document.querySelector(".prompt-input");
const sendButton = document.querySelector(".send-button");
const messageList = document.querySelector(".message-list");
const fileInput = document.querySelector(".file-input");
const attachmentChip = document.querySelector(".attachment-chip");
const attachmentName = attachmentChip.querySelector("span");
const voiceButton = document.querySelector(".voice-button");
const modelPillLabel = document.querySelector(".model-pill span");
const heroTitle = document.querySelector(".hero-title");
const heroSubtitle = document.querySelector(".hero-subtitle");
const toast = document.querySelector(".toast");
let toastTimer;
let currentMode = "text";

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function updateSendState() {
  const ready = promptInput.value.trim().length > 0 || attachmentChip.classList.contains("show");
  sendButton.disabled = !ready;
  sendButton.classList.toggle("ready", ready);
}

function autoResize() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 126)}px`;
}

function messageActions() {
  return '<div class="message-actions"><button class="message-action copy-action" type="button" aria-label="复制"><svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" stroke-width="1.5"/></svg></button></div>';
}

function addMessage(role, text, { html = false, typing = false, images = [] } = {}) {
  const item = document.createElement("article");
  item.className = `message ${role}${typing ? " typing-message" : ""}`;
  if (typing) item.innerHTML = '<div class="assistant-mark"><i class="mini-loader"></i></div><div class="message-content"><div class="typing"><i></i><i></i><i></i></div></div>';
  else if (role === "assistant") item.innerHTML = `<div class="assistant-mark"><i class="mini-loader"></i></div><div class="message-content"><div class="answer-content"></div>${messageActions()}</div>`;
  else item.innerHTML = '<div class="message-content"><p></p></div>';
  if (!typing) {
    if (role === "assistant") item.querySelector(".answer-content").innerHTML = `${html ? text : renderMarkdown(text)}${renderKnowledgeImages(images)}`;
    else item.querySelector("p").textContent = text;
  }
  messageList.appendChild(item);
  bindMessageActions(item);
  messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
  return item;
}

function bindMessageActions(scope) {
  scope.querySelectorAll(".copy-action").forEach((button) => button.addEventListener("click", async () => {
    const text = button.closest(".message-content").innerText.replace(/复制$/u, "").trim();
    try { await navigator.clipboard.writeText(text); showToast("已复制"); }
    catch { showToast("复制失败，请手动选择文本"); }
  }));
}

function saveConversation() {
  const turns = [...messageList.querySelectorAll(".message:not(.typing-message)")].map((node) => ({
    role: node.classList.contains("user") ? "user" : "assistant",
    text: node.innerText.trim(),
  })).slice(-20);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(turns)); } catch { /* ignore */ }
}

function restoreConversation() {
  let turns = [];
  try { turns = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { turns = []; }
  if (!Array.isArray(turns) || !turns.length) return;
  body.classList.add("chat-active");
  for (const turn of turns) addMessage(turn.role === "user" ? "user" : "assistant", turn.text || "");
}

async function submitMessage(rawText) {
  const text = String(rawText || "").trim();
  const fileText = attachmentChip.classList.contains("show") ? `附件：${attachmentName.textContent}` : "";
  if (!text && !fileText) return;
  body.classList.add("chat-active");
  addMessage("user", [text, fileText].filter(Boolean).join("\n"));
  promptInput.value = "";
  promptInput.style.height = "auto";
  fileInput.value = "";
  attachmentChip.classList.remove("show");
  updateSendState();
  const typing = addMessage("assistant", "", { typing: true });
  try {
    const response = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: text || fileText }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    typing.remove();
    if (!response.ok) throw new Error(data.error || "服务暂不可用，请稍后重试。");
    addMessage("assistant", data.answer || "暂时没有生成回答。", { images: data.images });
  } catch (error) {
    typing.remove();
    addMessage("assistant", error?.message || "服务暂不可用，请稍后重试。");
  }
  saveConversation();
}

function resetChat() {
  messageList.innerHTML = "";
  promptInput.value = "";
  promptInput.style.height = "auto";
  fileInput.value = "";
  attachmentChip.classList.remove("show");
  body.classList.remove("chat-active");
  document.querySelectorAll(".history-item").forEach((item) => item.classList.remove("current"));
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  updateSendState();
  setTimeout(() => promptInput.focus(), 220);
}

function loadHistory(key) {
  const examples = {
    overview: [["user", "实验室主要研究什么？"], ["assistant", "我会从已审核的实验室公开知识中检索研究方向、项目与成果，并给出结构化回答。"]],
    robots: [["user", "实验室现有的机器人平台包括哪些？"], ["assistant", "接入公开知识库后，我会按机器人平台、核心能力、应用场景和资料来源整理回答。"]],
    cooperation: [["user", "如何与实验室开展科研合作？"], ["assistant", "我会根据实验室公开信息说明合作方向、联系渠道和申请要求。"]],
  };
  messageList.innerHTML = "";
  body.classList.add("chat-active");
  for (const [role, text] of examples[key] || examples.overview) addMessage(role, text);
  document.querySelectorAll(".history-item").forEach((item) => item.classList.toggle("current", item.dataset.history === key));
}

async function refreshSuggestions() {
  try {
    const response = await fetch(apiUrl("/api/suggestions"));
    const data = await response.json();
    const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : []).map((item) => typeof item === "string" ? item : item.question).filter(Boolean).slice(0, 4);
    if (!suggestions.length) return;
    document.querySelector(".suggestions").innerHTML = suggestions.map((question, index) => `<button class="suggestion" type="button" data-prompt="${escapeHtml(question)}">${[icons.file, icons.text, icons.chart, icons.pen][index] || icons.chat}<span>${escapeHtml(question.replace(/[？?]$/u, ""))}</span></button>`).join("");
    bindSuggestions();
  } catch { /* keep defaults */ }
}

async function refreshStatus() {
  try {
    const response = await fetch(apiUrl("/api/status"));
    const status = await response.json();
    if (status && status.storageReady === false) showToast("资料服务暂不可用");
  } catch { /* visual preview can be static */ }
}

function bindSuggestions() {
  document.querySelectorAll(".suggestion").forEach((item) => item.addEventListener("click", () => submitMessage(item.dataset.prompt)));
}

form.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(promptInput.value); });
promptInput.addEventListener("input", () => { autoResize(); updateSendState(); });
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
});

document.querySelector(".attach-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  attachmentName.textContent = file.name;
  attachmentChip.classList.add("show");
  updateSendState();
});
voiceButton.addEventListener("click", () => showToast("语音输入将在正式服务中启用"));

document.querySelectorAll(".model-nav-item").forEach((item) => item.addEventListener("click", () => {
  document.querySelectorAll(".model-nav-item").forEach((button) => button.classList.remove("active"));
  item.classList.add("active");
  currentMode = item.dataset.mode;
  const copy = MODE_COPY[currentMode];
  heroTitle.textContent = copy[0];
  heroSubtitle.textContent = copy[1];
  promptInput.placeholder = copy[2];
  modelPillLabel.textContent = copy[3];
}));

document.querySelector(".new-chat-bottom").addEventListener("click", resetChat);
document.querySelectorAll(".history-item").forEach((item) => item.addEventListener("click", () => loadHistory(item.dataset.history)));
document.querySelector(".collapse-handle").addEventListener("click", () => body.classList.toggle("sidebar-collapsed"));
document.querySelector(".model-pill").addEventListener("click", () => showToast(`当前使用${MODE_COPY[currentMode][3]}`));
document.querySelector(".settings-trigger").addEventListener("click", () => showToast("设置与账号同步将在正式服务中启用"));

bindSuggestions();
restoreConversation();
refreshSuggestions();
refreshStatus();
updateSendState();

void openIncomingSharedAnswer();
