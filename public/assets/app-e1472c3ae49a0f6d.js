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

const APP_NAME = "ARTS Robotics AI Assistant";
const OA_PREVIEW_NAME = "联合研发 OA";
const OA_PREVIEW_BRAND = "ORIGINMIND × ARTS ROBOTICS";
const OFFICIAL_SITE = "https://omindos.ai";
const BAILIAN_CONSOLE = "https://bailian.console.aliyun.com/";
const OA_KNOWLEDGE_URL = "https://oa.omindos.ai/";
const OA_CHAT_IMPORT_URL = "https://oa.omindos.ai/api/knowledge/import-chat";
const OA_CHAT_IMPORT_STATUS_URL = "https://oa.omindos.ai/api/knowledge/import-chat/status";
const MAX_TEXT_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_IMPORT_FILES = 100;
const MAX_BATCH_IMPORT_BYTES = 500 * 1024 * 1024;
const BATCH_IMPORT_CONCURRENCY = 3;
const CHAT_DIRECT_OA_THRESHOLD_CHARACTERS = 30_000;
const MAX_OA_STORAGE_FRAGMENT_CHARACTERS = 20_000;
const SAFE_RETURNED_KNOWLEDGE_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORT_MIME_BY_EXTENSION = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

function importFilePath(file) {
  const candidate = typeof file?.webkitRelativePath === "string" && file.webkitRelativePath.trim()
    ? file.webkitRelativePath
    : file?.name;
  const path = String(candidate || "").normalize("NFC").replace(/\\/gu, "/").trim();
  const segments = path.split("/");
  if (
    !path ||
    path.length > 500 ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error("文件路径不正确，请重新选择文件。");
  }
  return path;
}

function classifyImportFile(file) {
  const path = importFilePath(file);
  const extension = path.split(".").at(-1)?.toLowerCase() || "";
  const isText = extension === "txt" || extension === "md";
  const isZip = extension === "zip";
  const mimeType = IMPORT_MIME_BY_EXTENSION[extension] || "";
  if (!isText && !mimeType && !isZip) {
    throw new Error(`${path}：仅支持 MD、ZIP、TXT、PDF、JPG、PNG 和 WebP 文件。`);
  }
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error(`${path}：文件为空。`);
  const maximum = isZip ? MAX_ZIP_IMPORT_BYTES : isText ? MAX_TEXT_IMPORT_BYTES : MAX_BINARY_IMPORT_BYTES;
  if (size > maximum) {
    throw new Error(
      isZip
        ? `${path}：ZIP 知识包不能超过 50 MB，请压缩图片或拆分资料。`
        : isText
          ? `${path}：TXT、Markdown 文件不能超过 5 MB。`
          : `${path}：PDF 或图片不能超过 10 MB，请压缩或拆分后重试。`,
    );
  }
  return {
    file,
    path,
    extension,
    isText,
    isZip,
    mimeType,
    kind: isZip ? "ZIP 知识包" : isText ? (extension === "md" ? "Markdown" : "文本") : extension === "pdf" ? "PDF" : "图片",
  };
}

function ignoredImportFile(file) {
  const path = String(file?.webkitRelativePath || file?.name || "").replace(/\\/gu, "/");
  return /(?:^|\/)(?:__MACOSX|\.DS_Store$|Thumbs\.db$)/iu.test(path);
}

function prepareImportFiles(files) {
  const selected = Array.from(files || []).filter((file) => !ignoredImportFile(file));
  if (!selected.length) throw new Error("请先选择需要导入的文件。");
  if (selected.length > MAX_BATCH_IMPORT_FILES) {
    throw new Error(`每批最多导入 ${MAX_BATCH_IMPORT_FILES} 个文件，请分批处理。`);
  }
  const descriptors = selected.map(classifyImportFile);
  const totalBytes = descriptors.reduce((total, item) => total + Number(item.file.size), 0);
  if (totalBytes > MAX_BATCH_IMPORT_BYTES) throw new Error("本批文件总大小不能超过 500 MB，请分批处理。");
  const paths = new Set();
  for (const descriptor of descriptors) {
    const identity = descriptor.path.toLocaleLowerCase("zh-CN");
    if (paths.has(identity)) throw new Error(`${descriptor.path}：存在重复文件路径，请整理后重试。`);
    paths.add(identity);
  }
  return descriptors.sort((left, right) => left.path.localeCompare(right.path, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  }));
}

function safeMarkdownImportLabel(value) {
  return String(value)
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[`<>]/gu, "")
    .replace(/#/gu, "＃")
    .trim()
    .slice(0, 500);
}

function importedSection(descriptor, text) {
  return `## ${descriptor.kind}：${safeMarkdownImportLabel(descriptor.path)}\n\n${normalizeImportedText(text).trim()}`;
}

function combineImportedSections(results, forceSections = false) {
  const successful = results.filter((result) => result?.text && result?.descriptor);
  if (!successful.length) return "";
  if (successful.length === 1 && !forceSections) return normalizeImportedText(successful[0].text).trim();
  return successful.map((result) => importedSection(result.descriptor, result.text)).join("\n\n---\n\n");
}

function suggestedBatchTitle(descriptors) {
  if (descriptors.length === 1) {
    return descriptors[0].path.replace(/\.(?:txt|md|zip|pdf|jpe?g|png|webp)$/iu, "").trim().slice(0, 120);
  }
  const roots = new Set(descriptors
    .map((descriptor) => descriptor.path.includes("/") ? descriptor.path.split("/", 1)[0] : "")
    .filter(Boolean));
  if (roots.size === 1) return [...roots][0].slice(0, 120);
  const imageOnly = descriptors.every((descriptor) => descriptor.kind === "图片");
  return `${imageOnly ? "图片资料" : "批量资料"}（${descriptors.length}项）`.slice(0, 120);
}

function normalizeImportedText(value) {
  return String(value)
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .normalize("NFKC");
}

function decodeImportedUtf8(bytes) {
  try {
    return normalizeImportedText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("TXT、Markdown 文件必须使用有效的 UTF-8 编码。");
  }
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function estimatedOaStorageFragmentCount(value) {
  return Math.max(1, Math.ceil(String(value).trim().length / MAX_OA_STORAGE_FRAGMENT_CHARACTERS));
}

function oaImportReceipt(payload, body) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : payload?.item && typeof payload.item === "object"
      ? [payload.item]
      : [];
  const topLevelCount = Number(payload?.partCount);
  const itemCount = items.reduce((total, item) => {
    const count = Number(item?.contentPartCount);
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
  return {
    items,
    partCount: Number.isSafeInteger(topLevelCount) && topLevelCount > 0
      ? topLevelCount
      : itemCount || estimatedOaStorageFragmentCount(body),
  };
}

function returnedKnowledgeItemIdFromSearch(search) {
  const params = new URLSearchParams(String(search || ""));
  const values = params.getAll("returnedKnowledgeItem");
  return values.length === 1 && SAFE_RETURNED_KNOWLEDGE_ITEM_ID.test(values[0]) ? values[0].toLowerCase() : "";
}

function withoutReturnedKnowledgeItemQuery(href) {
  const url = new URL(String(href));
  url.searchParams.delete("returnedKnowledgeItem");
  return `${url.pathname}${url.search}${url.hash}`;
}

const GENERAL_CHAT_TOPIC = Object.freeze({
  id: "general",
  path: "/",
  requestTopic: "research",
  title: "聊天",
  detail: "全部公开知识",
});

const TOPICS = [
  {
    id: "technology",
    path: "/technology",
    requestTopic: "research",
    index: "01",
    title: "成果与应用",
    detail: "核心成果 · 应用转化",
    eyebrow: "TECHNOLOGY & IMPACT",
    heading: "从核心技术到真实场景",
    intro: "了解数字孪生双臂操作、精密装配、智能巡检等成果与产业应用方向。",
  },
  {
    id: "academic",
    path: "/research",
    requestTopic: "research",
    index: "02",
    title: "科研与合作",
    detail: "国际合作 · 学术交流",
    eyebrow: "RESEARCH & EXCHANGE",
    heading: "与全球研究网络建立连接",
    intro: "了解团队的国际科研经历、合作网络与代表性研究成果。",
  },
  {
    id: "company",
    path: "/originmind",
    requestTopic: "business",
    index: "03",
    title: "公司与产品",
    detail: "机器人产品 · OmindOS",
    eyebrow: "ORIGINMIND",
    heading: "让机器人硬件与 OmindOS 协同工作",
    intro: "了解深圳源灵智能科技有限公司的机器人产品、工程适配与商业合作方案。",
  },
  {
    id: "association",
    path: "/ius",
    requestTopic: "student",
    index: "04",
    title: "协会与活动",
    detail: "学生创新 · 科技实践",
    eyebrow: "STUDENT INNOVATION",
    heading: "让学生创新走进机器人前沿",
    intro: "从协会指导教师与所在实验室出发，了解面向学生的智能无人系统研究方向、竞赛与创新成果。",
  },
];

const CHAT_TOPICS = Object.freeze([GENERAL_CHAT_TOPIC, ...TOPICS]);
const DEFAULT_TOPIC_ID = GENERAL_CHAT_TOPIC.id;
const TOPIC_ID_BY_PATH = new Map(CHAT_TOPICS.map((topic) => [topic.path, topic.id]));
const LAB_MODEL_CAPABILITIES = Object.freeze([
  { command: "@知识问答", title: "知识问答", detail: "检索实验室资料并回答" },
  { command: "@项目总结", title: "项目总结", detail: "整理进展、问题与下一步" },
  { command: "@资料处理", title: "资料处理", detail: "导入 TXT/MD/PDF 后处理" },
  { command: "@会议纪要", title: "会议纪要", detail: "生成纪要与行动项" },
]);

function topicIdForPath(pathname) {
  return TOPIC_ID_BY_PATH.get(pathname) || DEFAULT_TOPIC_ID;
}

function cleanPublicChatText(value) {
  const text = String(value ?? "");
  if (!/(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化|\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)\b)/iu.test(text.replace(/[\u200B-\u200D\uFEFF]/gu, ""))) return text.trim();
  return text
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/(?:已|经)?(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化)(?:处理)?(?:版本|版)?/gu, "")
    .replace(/\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)(?:[ -]+version)?\b/giu, "")
    .replace(/[（(【\[][ \t]*[）)】\]]/gu, "")
    .replace(/[ \t]+([，。！？；：）》】])/gu, "$1")
    .replace(/([《（【])[ \t]+/gu, "$1")
    .replace(/[_-]+(?=[》）】]|$)/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}

function knowledgeSuggestionsFromPayload(payload) {
  if (!Array.isArray(payload?.suggestions)) return [];
  const selected = [];
  for (const candidate of payload.suggestions) {
    const question = typeof candidate?.question === "string" ? cleanPublicChatText(candidate.question) : "";
    if (!question || question.length > 300 || selected.includes(question)) continue;
    selected.push(question);
    if (selected.length === 5) break;
  }
  return selected;
}

function isStandaloneWebApp(windowObject = window, navigatorObject = navigator) {
  const displayModeStandalone = typeof windowObject?.matchMedia === "function" &&
    windowObject.matchMedia("(display-mode: standalone)").matches;
  return displayModeStandalone || navigatorObject?.standalone === true;
}

function isAppleMobileDevice(navigatorObject = navigator) {
  const userAgent = String(navigatorObject?.userAgent || "");
  const platform = String(navigatorObject?.platform || "");
  const touchPoints = Number(navigatorObject?.maxTouchPoints) || 0;
  return /iPad|iPhone|iPod/u.test(userAgent) || (platform === "MacIntel" && touchPoints > 1);
}

function registerPublicServiceWorker(windowObject = window, navigatorObject = navigator, documentObject = document) {
  if (!navigatorObject?.serviceWorker || typeof navigatorObject.serviceWorker.register !== "function") return;
  const register = () => {
    void navigatorObject.serviceWorker.register("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    }).catch(() => {
      // Installation remains optional; a registration failure must never block chat.
    });
  };
  if (documentObject?.readyState === "complete") register();
  else windowObject.addEventListener("load", register, { once: true });
}

const TOPIC_LABELS = Object.freeze({
  student: "课题参与",
  research: "科研交流",
  business: "合作咨询",
});

const STATUS_LABELS = Object.freeze({
  pending: "待处理",
  replied: "已联系",
  closed: "已关闭",
});

const root = document.getElementById("app");

function element(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.text !== undefined && options.text !== null) {
    node.textContent = String(options.text);
  }
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(text, className = "icon") {
  return element("span", {
    className,
    text,
    attributes: { "aria-hidden": "true" },
  });
}

function textButton(label, className = "") {
  const button = element("button", { className, text: label });
  button.type = "button";
  return button;
}

function brandLink() {
  const link = element("a", {
    className: "wordmark",
    attributes: { href: "/", "aria-label": "OriginMind 首页" },
  });
  link.append(document.createTextNode("OriginMind"));
  link.append(element("span", { className: "brand-square", attributes: { "aria-hidden": "true" } }));
  return link;
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(label, href, className = "") {
  const safeHref = safeHttpUrl(href);
  if (!safeHref) return null;
  const link = element("a", {
    className,
    attributes: {
      href: safeHref,
      target: "_blank",
      rel: "noopener noreferrer",
    },
  });
  link.append(document.createTextNode(label), icon("↗", "link-arrow"));
  return link;
}

function setRegion(region, message) {
  region.textContent = message || "";
  region.hidden = !message;
}

async function requestJson(path, options = {}) {
  const {
    timeoutMessage = "请求超时，请稍后重试。",
    ...requestOptions
  } = options;
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...requestOptions,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw new Error("暂时无法连接服务，请稍后重试。");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON response is treated as an unavailable service below.
  }

  if (!response.ok) {
    const fallback = response.status === 401 ? "登录状态已失效，请重新登录。" : "服务暂时不可用，请稍后重试。";
    throw new Error(typeof payload?.error === "string" ? payload.error : fallback);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("服务返回异常，请稍后重试。");
  }
  return payload;
}

function jsonOptions(body, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const PUBLIC_ANALYTICS_EVENT_TYPES = Object.freeze([
  "page_view",
  "suggestion_impression",
  "suggestion_click",
  "new_chat",
  "install_success",
]);
const PUBLIC_ANALYTICS_EVENT_TYPE_SET = new Set(PUBLIC_ANALYTICS_EVENT_TYPES);
const PUBLIC_ANALYTICS_RECOMMENDATION_TYPES = new Set(["suggestion_impression", "suggestion_click"]);
const PUBLIC_ANALYTICS_MAX_BATCH_SIZE = 5;

function createAnalyticsQueue(fetcher = fetch) {
  const queue = [];
  let flushScheduled = false;

  function flush() {
    flushScheduled = false;
    while (queue.length) {
      const events = queue.splice(0, PUBLIC_ANALYTICS_MAX_BATCH_SIZE);
      try {
        const request = fetcher("/api/analytics", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          keepalive: true,
        });
        Promise.resolve(request).catch(() => {});
      } catch {
        // Anonymous product analytics must never interrupt the public chat.
      }
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    Promise.resolve().then(flush);
  }

  function track(type, { section, suggestion } = {}) {
    if (!PUBLIC_ANALYTICS_EVENT_TYPE_SET.has(type)) return false;
    const normalizedSection = String(section || "").trim();
    if (!CHAT_TOPICS.some((topic) => topic.id === normalizedSection)) return false;
    const event = { type, section: normalizedSection };
    if (PUBLIC_ANALYTICS_RECOMMENDATION_TYPES.has(type)) {
      const normalizedSuggestion = String(suggestion || "").trim();
      if (!normalizedSuggestion || normalizedSuggestion.length > 300) return false;
      event.suggestion = normalizedSuggestion;
    }
    queue.push(event);
    scheduleFlush();
    return true;
  }

  return { track, flush };
}

function makeRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function adminSourceOriginLabel(origin) {
  return origin === "oa_public" ? "OA 已审核公开" : "Chat 待审核草稿";
}

function referenceSectionStart(value) {
  const lineMarkers = [
    value.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：]|(?=[\[［【]\s*[0-9０-９]))/imu,
    ),
    value.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：])?[ \t]*$/imu,
    ),
    value.match(
      /(?:^|\r?\n)[ \t]*(?:[-+*•>][ \t]+)?[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/u,
    ),
  ].filter(Boolean);
  const inlineMarker = value.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu,
  );
  const inlineCitationMarker = value.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited)[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?=[\[［【]\s*[0-9０-９])/iu,
  );
  const indexes = lineMarkers.map((marker) => marker.index);
  if (inlineMarker) indexes.push(inlineMarker.index + inlineMarker[1].length);
  if (inlineCitationMarker) indexes.push(inlineCitationMarker.index + inlineCitationMarker[1].length);
  return indexes.length ? Math.min(...indexes) : -1;
}

// BEGIN SHARED ANSWER TOKENS
// Kept byte-for-byte in frontend/app.js between SHARED ANSWER TOKENS markers.
// A token is recognized before Markdown escapes, tables, or citation cleanup.
function answerCodeTokenAt(text, index) {
  const remaining = text.slice(index);
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const fence = /^[ \t]*$/u.test(text.slice(lineStart, index))
    ? remaining.match(/^(`{3,}|~{3,})([^\n]*)\n/u) : null;
  if (fence) {
    const close = new RegExp(`^[ \\t]*${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\n|$)`, "gmu");
    close.lastIndex = index + fence[0].length;
    const end = close.exec(text);
    const stop = end ? end.index + end[0].length - (end[0].endsWith("\n") ? 1 : 0) : text.length;
    return { kind: "code", raw: text.slice(index, stop), end: stop };
  }
  const ticks = remaining.match(/^`+/u)?.[0];
  if (!ticks) return null;
  let end = text.indexOf(ticks, index + ticks.length);
  while (end !== -1 && (text[end - 1] === "`" || text[end + ticks.length] === "`")) {
    end = text.indexOf(ticks, end + ticks.length);
  }
  return end === -1 ? null : {
    kind: "code", raw: text.slice(index, end + ticks.length),
    content: text.slice(index + ticks.length, end), end: end + ticks.length,
  };
}

function answerMathTokenAt(text, index) {
  let left = "";
  let right = "";
  let display = false;
  let environment = false;
  if (text.startsWith("\\[", index)) { left = "\\["; right = "\\]"; display = true; }
  else if (text.startsWith("\\(", index)) { left = "\\("; right = "\\)"; }
  else if (text.startsWith("$$", index)) { left = right = "$$"; display = true; }
  else if (text[index] === "$" && text[index - 1] !== "$" && text[index + 1] !== "$") { left = right = "$"; }
  else if (text.startsWith("\\begin{", index)) {
    const match = text.slice(index).match(/^\\begin\{((?:equation|align|alignat|aligned|alignedat|gather|gathered|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases)\*?)\}/u);
    if (match) { left = match[0]; right = `\\end{${match[1]}}`; display = environment = true; }
  }
  if (!left) return null;
  const start = index + left.length;
  let end = text.indexOf(right, start);
  while (end !== -1) {
    let slashes = 0;
    for (let cursor = end - 1; cursor >= start && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0 && (right !== "$" || text[end + 1] !== "$")) break;
    end = text.indexOf(right, end + right.length);
  }
  if (end === -1) return null;
  const content = text.slice(start, end);
  // Model answers often emit "$ L = T - V $". Permit padded math without
  // consuming currency prose such as "$5 and $10" or "$ 5 and $ 10".
  const trimmed = content.trim();
  if (left === "$") {
    if (!trimmed || /\r|\n/u.test(content) || /\d/u.test(text[end + 1] || "")) return null;
    const padded = content !== trimmed;
    const looksMathematical = /\\[a-zA-Z]|[_^=+*/<>\-≤≥≠−]/u.test(trimmed) || /^[\p{L}\p{N}.]+$/u.test(trimmed);
    if (padded && !looksMathematical) return null;
  }
  const raw = text.slice(index, end + right.length);
  return { kind: "math", raw, tex: environment ? raw : content, display, end: end + right.length };
}

function normalizeAnswerMathTex(value) {
  return String(value).replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*?)\\end\{\1\}/gu,
    (original, environment, body) => {
      if (/\\(?:begin|end|text|verb|multicolumn|hline)\b/u.test(body)) return original;
      const lines = body.split("\n");
      const rows = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
      if (rows.length < 2 || rows.length > 50) return original;
      const columns = rows.map(({ line }) => (line.match(/(?<!\\)&/gu) || []).length);
      if (columns[0] < 1 || columns.some((count) => count !== columns[0])) return original;
      const preceding = rows.slice(0, -1);
      if (preceding.some(({ line }) => !/(?<!\\)\\{1,2}[ \t\r]*$/u.test(line))) return original;
      for (const { line, index } of preceding) {
        lines[index] = line.replace(/(?<!\\)\\([ \t\r]*)$/u, (_, spaces) => "\\\\" + spaces);
      }
      return `\\begin{${environment}}${lines.join("\n")}\\end{${environment}}`;
    },
  );
}

function protectAnswerTechnicalText(value, { code = true } = {}) {
  const input = String(value ?? "");
  let prefix = "\uE000M";
  while (input.includes(prefix)) prefix += "M";
  const originals = [];
  let text = "";
  for (let index = 0; index < input.length;) {
    const token = (input[index] === "`" || input[index] === "~" ? answerCodeTokenAt(input, index) : null) ||
      (input[index] === "\\" || input[index] === "$" ? answerMathTokenAt(input, index) : null);
    if (token?.kind === "code" && !code) {
      text += token.raw; index = token.end;
    } else if (token) {
      text += `${prefix}${originals.length}\uE001`;
      originals.push(token);
      index = token.end;
    } else if (input[index] === "\\" && index + 1 < input.length) {
      text += input.slice(index, index + 2); index += 2;
    } else { text += input[index++]; }
  }
  return {
    text, prefix, tokens: originals,
    restore: (output) => String(output).replace(new RegExp(`${prefix}(\\d+)\uE001`, "gu"),
      (match, index) => originals[Number(index)]?.raw ?? match),
  };
}

// END SHARED ANSWER TOKENS

// BEGIN SHARED ANSWER PRESENTATION
// Recover only unambiguous, pipe-bounded rows with a real Markdown divider.
// Empty/escaped cells and malformed rows remain untouched; never guess cells.
function restoreFlattenedAnswerTables(value) {
  return value.split("\n").map((line) => {
    if (!/\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(line)) return line;
    const rows = line.split(/\|[ \t]*\|/u);
    if (rows.length < 3) return line;
    for (let index = 1; index < rows.length; index += 1) {
      const divider = rows[index].split("|").map((cell) => cell.trim());
      if (divider.length < 2 || divider.length > 8 || !divider.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      const firstPipe = rows[index - 1].indexOf("|");
      if (firstPipe < 0) continue;
      const prefix = rows[index - 1].slice(0, firstPipe).trim();
      const header = rows[index - 1].slice(firstPipe + 1).split("|").map((cell) => cell.trim());
      if (header.length !== divider.length || header.some((cell) => !cell || /\\|\uE000/u.test(cell))) continue;
      const output = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];
      let last = index;
      for (let row = index + 1; row < rows.length; row += 1) {
        const cells = rows[row].replace(/\|[ \t]*$/u, "").split("|").map((cell) => cell.trim());
        if (cells.length !== header.length || cells.some((cell) => !cell || /\\|\uE000/u.test(cell))) break;
        output.push(`| ${cells.join(" | ")} |`); last = row;
      }
      if (last === index) continue;
      // A single table only; leave any unparsed suffix visible, not reassigned.
      const before = rows.slice(0, index - 1).join("||");
      const after = rows.slice(last + 1).join("||");
      return [before, prefix, output.join("\n"), after].filter(Boolean).join("\n\n");
    }
    return line;
  }).join("\n");
}

// Keep this function identical in frontend/app.js. Clean only presentation:
// evidence, source IDs, citations, and stored OA documents remain unchanged.
function cleanAnswerPresentation(value, { title = "", document = false } = {}) {
  const protectedText = protectAnswerTechnicalText(value);
  let text = protectedText.text.replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  const legacyLead = /(?:知识库中与这个问题直接相关的内容包括|(?:知识库中|检索到的)(?:与(?:该|这个)问题)?(?:直接)?相关(?:的)?内容(?:包括|如下))\s*[:：]/u;
  const legacy = legacyLead.test(text);
  text = text.replace(new RegExp(`^[ \\t]*${legacyLead.source}[ \\t]*\\n*`, "u"), "");

  // Strip real document front matter, never a normal Markdown horizontal rule.
  text = text.replace(/^\s*---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u, (whole, body) =>
    /^(?:title|version|updated(?:_at)?|date|source|author)\s*:/imu.test(body) ? "" : whole);
  const metaName = "(?:文档版本|资料版本|版本(?:号)?|更新(?:时间|日期)|适用范围|文件名|文档名称|资料名称)";
  const sourceName = "(?:资料来源|文档来源|文件来源|参考来源|出处|引自|摘自|出自|来源)";
  const linePrefix = "^[ \\t]*(?:[-+*•][ \\t]+)?(?:>[ \\t]*)?(?:#{1,6}[ \\t]+)?(?:\\*\\*)?";
  const metaLine = new RegExp(`${linePrefix}${metaName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const sourceLine = new RegExp(`${linePrefix}${sourceName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const flattenedMetadata = new RegExp(`>[ \\t]*(?:${metaName}|${sourceName})[ \\t]*[:：]`, "u").test(text);

  const collapsedBlocks = /[^\n][ \t]+#{2,6}[ \t]+\S/u.test(text) ||
    /\|[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(text);
  if (legacy || flattenedMetadata || collapsedBlocks) {
    // Older retrieval replies put '- # title > version ... ## section' on one line.
    // Recreate block boundaries before discarding document headers.
    text = text.replace(/^[ \t]*[-+*•][ \t]+(?=#{1,6}[ \t])/gmu, "")
      .replace(/[ \t]+(?=#{1,6}[ \t]+\S)/gu, "\n\n")
      .replace(new RegExp(`[ \\t]*>[ \\t]*(?=(?:${metaName}|${sourceName})[ \\t]*[:：])`, "gu"), "\n")
      .replace(/(#{1,6}[ \t]+[一二三四五六七八九十百\d]+[、.．][^\s#]{1,32})[ \t]+(?=\S)/gu, "$1\n\n");
  }
  text = restoreFlattenedAnswerTables(text);
  // Slides often join a numbered page title to its body after the English
  // page label. Split at that explicit boundary rather than guessing words.
  text = text.replace(/^(#{1,6}[ \t]+第[ \t]*\d+[ \t]*页[^\n()（）]{0,70}[（(][A-Z][A-Z \d-]{2,60}[)）])[ \t]*(?=\S)/gmu, "$1\n\n");
  const lines = text.split("\n");
  const normalizeTitle = (s) => String(s).normalize("NFKC").replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
  const knownTitle = normalizeTitle(title).split(" · ")[0];
  const metaCount = lines.filter((line) => metaLine.test(line)).length;
  const headerMode = document || legacy || flattenedMetadata || collapsedBlocks || (metaCount >= 2 && lines.some((line) => /^(?:[ \t]*>[ \t]*)?(?:更新时间|更新日期|文档版本|资料版本)[ \t]*[:：]/u.test(line)));
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (sourceLine.test(line)) continue;
    // Only whole metadata lines are suppressed. Restriction notices remain
    // in source data and must never be treated as public-sharing permission.
    if (headerMode && /^[ \t]*(?:>[ \t]*)?(?:页脚|视觉说明)[ \t]*[:：]/u.test(line)) continue;
    if (/^[ \t]*参考(?:公司|实验室)(?:主页|官网)(?:的)?(?:介绍和描述|介绍|描述)[。.]?[ \t]*$/u.test(line)) continue;
    if (headerMode && metaLine.test(line)) continue;
    if (/^[ \t]*(?:[-+*•][ \t]+)?(?:本(?:文|段|回答|内容)|以上内容|上述内容)?(?:引自|摘自|出自)[ \t]*[《“「][^\n]+[》”」][。.]?[ \t]*$/u.test(line)) continue;
    const heading = line.match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
    if (heading) {
      const matchesTitle = knownTitle && normalizeTitle(heading[1]) === knownTitle;
      const followedByMetadata = /^\s*#[ \t]+/u.test(line) && metaLine.test(lines.slice(index + 1).find((next) => next.trim()) || "");
      if ((document && matchesTitle) || (headerMode && followedByMetadata)) continue;
      // A collapsed page must not turn hundreds of body characters bold.
      if (heading[1].length > 100) line = heading[1];
    }
    // Remove an attribution lead, but keep its actual conclusion and [n] evidence.
    line = line.replace(/^(?:根据|依据|据)[ \t]*《[^》\n]+》(?:中(?:的)?(?:介绍|说明|记载|内容|描述)|(?:记载|介绍|说明|显示|指出))?[ \t]*[，,:：][ \t]*/u, "")
      .replace(/^(?:根据|依据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:知识库|资料|文档)(?:内容)?(?:显示|可知|表明|记载|介绍|说明)?[ \t]*[，,:：][ \t]*/u, "");
    output.push(line.replace(/[ \t]+$/gu, ""));
  }
  return protectedText.restore(output.join("\n").replace(/\n{3,}/gu, "\n\n").trim());
}

// Bound prose without splitting a formula or a code block. Prefer a completed
// paragraph/sentence near the cap; normal short excerpts are never flattened.
function boundedKnowledgeExcerpt(value, maximum = 1800) {
  const technical = protectAnswerTechnicalText(value);
  const characters = Array.from(technical.text);
  if (characters.length <= maximum) return String(value);
  let prefix = characters.slice(0, maximum).join("");
  const unfinished = prefix.lastIndexOf(technical.prefix);
  if (unfinished >= 0 && !prefix.slice(unfinished).includes("\uE001")) prefix = prefix.slice(0, unfinished);
  const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf("。") + 1, prefix.lastIndexOf("！") + 1, prefix.lastIndexOf("？") + 1);
  if (boundary > maximum / 2) prefix = prefix.slice(0, boundary);
  return `${technical.restore(prefix.trimEnd())}…`;
}
// END SHARED ANSWER PRESENTATION

function userFacingAnswer(value) {
  const technical = protectAnswerTechnicalText(cleanAnswerPresentation(cleanPublicChatText(value)));
  const answer = technical.text;
  const sectionStart = referenceSectionStart(answer);
  const answerBody = sectionStart === -1 ? answer : answer.slice(0, sectionStart);
  if (/\[\s*\[\s*[0-9０-９][\s\S]*?\]\s*\]/u.test(answerBody)) return "暂时没有可显示的回答。";
  const withoutReferences = answerBody
    .replace(
      /[ \t]*[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/gu,
      "",
    )
    .replace(
      /^(?:(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料(?:显示|可知|表明)|参考资料(?:显示|表明|提到)|(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料)[，,:：]\s*/u,
      "",
    )
    .replace(/[ \t]+([，。！？；：])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const hasResidualMarker =
    /[\[［【][^\]］】\r\n]*[0-9０-９]+[^\]］】\r\n]*[\]］】]/u.test(withoutReferences) ||
    /(?:参考资料|参考文献|参考来源|资料来源)/u.test(withoutReferences) ||
    /(?:^|[^\p{L}\p{N}_*`#~-])(?:参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu.test(withoutReferences) ||
    /(?:^|[^\p{L}\p{N}_-])(?:references?|sources?|citations?|bibliography|works[ \t]+cited)(?:[ \t]+list)?[ \t]*[:：]/iu.test(withoutReferences) ||
    referenceSectionStart(withoutReferences) !== -1;
  return withoutReferences && !hasResidualMarker ? technical.restore(withoutReferences) : "暂时没有可显示的回答。";
}

const CHAT_HISTORY_KEY = "arts-public-chat-history-v1:";
const CHAT_CONVERSATIONS_KEY = "arts-public-chat-conversations-v2";
const CHAT_INSTALL_ANALYTICS_KEY = "arts-public-chat-install-analytics-v1";
const CHAT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const CHAT_HISTORY_MAX_CHARS = 80_000;
const CHAT_HISTORY_MAX_MESSAGES = 40;
const CHAT_CONVERSATION_LIMIT = 20;
const CHAT_RECENT_LIMIT = 8;
const CHAT_TITLE_MAX_CHARACTERS = 30;
const CHAT_CONVERSATIONS_MAX_STORED_CHARS = 2_000_000;

function validatedKnowledgeImages(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value.slice(0, 4)) {
    if (!item || typeof item.url !== "string" ||
        !/^\/api\/knowledge\/assets\/v1_[A-Za-z0-9_-]{80,320}$/u.test(item.url) ||
        !["image/png", "image/jpeg", "image/webp"].includes(item.mimeType) ||
        typeof item.alt !== "string" || !item.alt.trim() || item.alt.length > 120 || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push({ url: item.url, mimeType: item.mimeType, alt: item.alt });
  }
  return result;
}

function knowledgeImageFields(message) {
  const images = message?.role === "assistant" ? validatedKnowledgeImages(message.images) : [];
  return {
    ...(images.length ? { images } : {}),
    ...(message?.role === "assistant" && message.publicSources === true ? { publicSources: true } : {}),
  };
}

function renderKnowledgeImages(images) {
  const gallery = element("div", { className: "knowledge-images", attributes: { "aria-label": "公开资料关联图片" } });
  for (const asset of validatedKnowledgeImages(images)) {
    const figure = element("figure", { className: "knowledge-figure" });
    const image = element("img", { attributes: {
      src: asset.url, alt: asset.alt, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
    } });
    const caption = element("figcaption", { text: asset.alt });
    image.addEventListener("error", () => {
      image.hidden = true;
      caption.textContent = `${asset.alt}（图片已失效、撤回或暂不可用，请重新提问刷新。）`;
    }, { once: true });
    figure.append(image, caption);
    gallery.append(figure);
  }
  return gallery;
}

function boundedChatMessages(messages) {
  const result = [];
  let remaining = CHAT_HISTORY_MAX_CHARS;
  for (const item of (Array.isArray(messages) ? messages : []).slice(-CHAT_HISTORY_MAX_MESSAGES).reverse()) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") continue;
    const content = item.content.slice(0, item.role === "user" ? 2000 : 12_000);
    if (!content.trim() || content.length > remaining) break;
    result.unshift({ role: item.role, content, ...knowledgeImageFields(item) });
    remaining -= content.length;
  }
  while (result[0]?.role === "assistant") result.shift();
  return result;
}

function chatHistorySnapshot(section, session, now = Date.now()) {
  const messages = [...session.messages];
  const interrupted = session.sending && messages.at(-1)?.role === "user" ? messages.pop().content : "";
  return {
    version: 1, section, savedAt: now,
    messages: boundedChatMessages(messages),
    draft: String(session.draft || interrupted || "").slice(0, 2000),
    interrupted: Boolean(interrupted),
    conversationToken: typeof session.conversationToken === "string" ? session.conversationToken.slice(0, 40_000) : "",
    tokenSavedAt: Number.isFinite(session.tokenSavedAt) ? session.tokenSavedAt : 0,
    scrollTop: Number.isFinite(session.scrollTop) ? Math.max(0, session.scrollTop) : 0,
    stickToEnd: session.stickToEnd !== false,
  };
}

function readChatHistory(storage, section, now = Date.now()) {
  try {
    const raw = storage?.getItem(CHAT_HISTORY_KEY + section);
    if (!raw) return null;
    if (raw.length > 800_000) throw new Error("Oversized history");
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || value.section !== section ||
        !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt >= CHAT_HISTORY_TTL_MS ||
        !Array.isArray(value.messages) || value.messages.length > CHAT_HISTORY_MAX_MESSAGES ||
        value.messages.some((item) => !item || !["user", "assistant"].includes(item.role) ||
          typeof item.content !== "string" || item.content.length > (item.role === "user" ? 2000 : 12_000)) ||
        typeof value.draft !== "string" || value.draft.length > 2000) throw new Error("Invalid history");
    const tokenFresh = Number.isFinite(value.tokenSavedAt) && value.tokenSavedAt > 0 &&
      value.tokenSavedAt <= now && now - value.tokenSavedAt < CHAT_TOKEN_TTL_MS;
    return {
      savedAt: value.savedAt,
      messages: boundedChatMessages(value.messages).map((item) => ({
        role: item.role,
        content: item.role === "assistant" ? userFacingAnswer(item.content) : item.content,
        ...knowledgeImageFields(item),
      })),
      draft: value.draft,
      conversationToken: tokenFresh && typeof value.conversationToken === "string" && value.conversationToken.length <= 40_000
        ? value.conversationToken : "",
      tokenSavedAt: tokenFresh ? value.tokenSavedAt : 0,
      scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0,
      stickToEnd: value.stickToEnd !== false,
      sending: false,
      error: "",
      notice: value.interrupted ? "上次回答未完成，问题已保留在输入框中，可重新发送。" : "",
    };
  } catch {
    try { storage?.removeItem(CHAT_HISTORY_KEY + section); } catch { /* Storage may be disabled. */ }
    return null;
  }
}

function writeChatHistory(storage, section, session, now = Date.now()) {
  try {
    if (!storage) return false;
    const value = chatHistorySnapshot(section, session, now);
    if (!value.messages.length && !value.draft) storage.removeItem(CHAT_HISTORY_KEY + section);
    else storage.setItem(CHAT_HISTORY_KEY + section, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function chatConversationTitle(messages, fallback = "新聊天") {
  const firstQuestion = (Array.isArray(messages) ? messages : [])
    .find((message) => message?.role === "user" && typeof message.content === "string")?.content || "";
  const normalized = firstQuestion
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return fallback;
  const characters = Array.from(normalized);
  return characters.length > CHAT_TITLE_MAX_CHARACTERS
    ? `${characters.slice(0, CHAT_TITLE_MAX_CHARACTERS).join("")}…`
    : normalized;
}

function chatConversationsSnapshot(conversations, activeConversationId, now = Date.now()) {
  const items = (Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => conversation && typeof conversation.id === "string" &&
      typeof conversation.section === "string" && Number.isFinite(conversation.updatedAt) &&
      conversation.updatedAt <= now && now - conversation.updatedAt < CHAT_HISTORY_TTL_MS &&
      (conversation.messages?.length || String(conversation.draft || "").trim()))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, CHAT_CONVERSATION_LIMIT)
    .map((conversation) => {
      const snapshot = chatHistorySnapshot(conversation.section, conversation, conversation.updatedAt);
      return {
        ...snapshot,
        id: conversation.id,
        title: chatConversationTitle(snapshot.messages, String(conversation.title || "新聊天")),
        createdAt: Number.isFinite(conversation.createdAt) && conversation.createdAt <= conversation.updatedAt
          ? conversation.createdAt : conversation.updatedAt,
        updatedAt: conversation.updatedAt,
      };
    });
  return {
    version: 2,
    savedAt: now,
    activeConversationId: items.some((item) => item.id === activeConversationId) ? activeConversationId : items[0]?.id || "",
    conversations: items,
  };
}

function writeChatConversations(storage, conversations, activeConversationId, now = Date.now()) {
  try {
    if (!storage) return false;
    const value = chatConversationsSnapshot(conversations, activeConversationId, now);
    if (!value.conversations.length) storage.removeItem(CHAT_CONVERSATIONS_KEY);
    else {
      let serialized = JSON.stringify(value);
      while (serialized.length > CHAT_CONVERSATIONS_MAX_STORED_CHARS && value.conversations.length > 1) {
        let oldestInactiveIndex = value.conversations.length - 1;
        while (oldestInactiveIndex >= 0 &&
          value.conversations[oldestInactiveIndex].id === value.activeConversationId) oldestInactiveIndex -= 1;
        value.conversations.splice(oldestInactiveIndex >= 0 ? oldestInactiveIndex : value.conversations.length - 1, 1);
        if (!value.conversations.some((conversation) => conversation.id === value.activeConversationId)) {
          value.activeConversationId = value.conversations[0]?.id || "";
        }
        serialized = JSON.stringify(value);
      }
      if (serialized.length > CHAT_CONVERSATIONS_MAX_STORED_CHARS) return false;
      storage.setItem(CHAT_CONVERSATIONS_KEY, serialized);
    }
    return true;
  } catch {
    return false;
  }
}

function readChatConversations(storage, allowedSections, now = Date.now()) {
  try {
    const raw = storage?.getItem(CHAT_CONVERSATIONS_KEY);
    if (!raw) return null;
    if (raw.length > CHAT_CONVERSATIONS_MAX_STORED_CHARS) throw new Error("Oversized conversation history");
    const value = JSON.parse(raw);
    const allowed = new Set(Array.isArray(allowedSections) ? allowedSections : []);
    if (!value || value.version !== 2 || !Array.isArray(value.conversations) ||
        value.conversations.length > CHAT_CONVERSATION_LIMIT) throw new Error("Invalid conversation history");
    const conversations = [];
    const seen = new Set();
    for (const item of value.conversations) {
      if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/u.test(item.id) || seen.has(item.id) ||
          !allowed.has(item.section) || !Number.isFinite(item.updatedAt) || item.updatedAt > now ||
          now - item.updatedAt >= CHAT_HISTORY_TTL_MS || !Array.isArray(item.messages) ||
          item.messages.length > CHAT_HISTORY_MAX_MESSAGES ||
          item.messages.some((message) => !message || !["user", "assistant"].includes(message.role) ||
            typeof message.content !== "string" || message.content.length > (message.role === "user" ? 2000 : 12_000)) ||
          typeof item.draft !== "string" || item.draft.length > 2000) continue;
      const tokenFresh = Number.isFinite(item.tokenSavedAt) && item.tokenSavedAt > 0 &&
        item.tokenSavedAt <= now && now - item.tokenSavedAt < CHAT_TOKEN_TTL_MS;
      const messages = boundedChatMessages(item.messages).map((message) => ({
        role: message.role,
        content: message.role === "assistant" ? userFacingAnswer(message.content) : message.content,
        ...knowledgeImageFields(message),
      }));
      const interrupted = item.interrupted === true;
      conversations.push({
        id: item.id,
        section: item.section,
        title: chatConversationTitle(messages, typeof item.title === "string" ? item.title.slice(0, 80) : "新聊天"),
        createdAt: Number.isFinite(item.createdAt) && item.createdAt <= item.updatedAt ? item.createdAt : item.updatedAt,
        updatedAt: item.updatedAt,
        messages,
        draft: String(item.draft || ""),
        conversationToken: tokenFresh && typeof item.conversationToken === "string" && item.conversationToken.length <= 40_000
          ? item.conversationToken : "",
        tokenSavedAt: tokenFresh ? item.tokenSavedAt : 0,
        scrollTop: Number.isFinite(item.scrollTop) ? Math.max(0, item.scrollTop) : 0,
        stickToEnd: item.stickToEnd !== false,
        sending: false,
        error: "",
        notice: interrupted ? "上次回答未完成，问题已保留在输入框中，可重新发送。" : "",
      });
      seen.add(item.id);
    }
    conversations.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    if (!conversations.length) {
      storage.removeItem(CHAT_CONVERSATIONS_KEY);
      return null;
    }
    return {
      conversations,
      activeConversationId: conversations.some((item) => item.id === value.activeConversationId)
        ? value.activeConversationId : conversations[0].id,
    };
  } catch {
    try { storage?.removeItem(CHAT_CONVERSATIONS_KEY); } catch { /* Storage may be disabled. */ }
    return null;
  }
}

function recentChatConversations(conversations) {
  return (Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => Array.isArray(conversation?.messages) &&
      conversation.messages.some((message) => message?.role === "user" && String(message.content || "").trim()))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, CHAT_RECENT_LIMIT);
}

const ANSWER_MATH_ASSET = "/assets/katex-cc567bec51ade0dc.mjs";
let answerMathEngine = null;
let answerMathLoading = null;
let answerMathRequestSequence = 0;

function loadAnswerMathEngine() {
  if (answerMathEngine) return Promise.resolve(answerMathEngine);
  if (!answerMathLoading) {
    // A transient import error must not poison later answers in this tab.
    // Distinct URLs also bypass the browser's cached failed module promises.
    answerMathLoading = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
        try {
          const sequence = answerMathRequestSequence++;
          const url = sequence ? `${ANSWER_MATH_ASSET}?retry=${sequence}` : ANSWER_MATH_ASSET;
          const mathModule = await import(url);
          if (typeof mathModule.default?.render !== "function") throw new TypeError("Invalid formula engine");
          answerMathEngine = mathModule.default;
          return answerMathEngine;
        } catch { /* Keep the original formula visible until a retry succeeds. */ }
      }
      return null;
    })().finally(() => { answerMathLoading = null; });
  }
  return answerMathLoading;
}

function renderAnswerMath(token, budget = { count: 0, characters: 0 }) {
  const node = element("span", {
    className: `answer-math${token.display ? " answer-math-block" : ""}`,
    attributes: { "data-math-status": "pending" },
    text: token.raw,
  });
  const fallback = (reason) => {
    node.textContent = token.raw;
    node.setAttribute("data-math-status", "fallback");
    node.setAttribute("title", reason);
  };
  budget.count += 1; budget.characters += token.tex.length;
  if (token.tex.length > 8_000 || budget.count > 160 || budget.characters > 24_000) {
    fallback("公式较复杂，已保留原始写法。");
    return node;
  }
  const render = (engine) => {
    if (!engine?.render) { fallback("公式组件暂不可用，已保留原始写法。"); return; }
    try {
      engine.render(normalizeAnswerMathTex(token.tex), node, {
        displayMode: token.display,
        // Native MathML needs no remote stylesheets or downloaded font files.
        output: "mathml", trust: false, throwOnError: true,
        strict: "ignore", maxExpand: 1_000, maxSize: 10,
      });
      node.setAttribute("data-math-status", "rendered");
    } catch {
      fallback("此公式暂未识别，已保留原始写法。");
    }
  };
  if (answerMathEngine) render(answerMathEngine);
  else if (typeof window !== "undefined") void loadAnswerMathEngine().then(render);
  return node;
}

function answerMaskedMathAt(text, index, technical) {
  if (!technical || !text.startsWith(technical.prefix, index)) return null;
  const end = text.indexOf("\uE001", index + technical.prefix.length);
  if (end < 0) return null;
  const number = text.slice(index + technical.prefix.length, end);
  if (!/^\d+$/u.test(number)) return null;
  const token = technical.tokens[Number(number)];
  return token?.kind === "math" ? { token, end: end + 1 } : null;
}

function answerEmphasisEnd(text, start, marker) {
  for (let index = start; index < text.length;) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === "`") {
      const code = answerCodeTokenAt(text, index);
      if (code) { index = code.end; continue; }
    }
    if (text.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

function answerDisplayLinkAt(text, index) {
  const image = text.startsWith("![", index);
  const start = image ? index + 1 : index;
  if (text[start] !== "[") return null;
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd < 0 || labelEnd - start > 500 || /[\n\r]/u.test(text.slice(start, labelEnd))) return null;
  let nesting = 1;
  for (let end = labelEnd + 2; end < Math.min(text.length, labelEnd + 2050); end += 1) {
    if (text[end] === "\\") { end += 1; continue; }
    if (text[end] === "(") nesting += 1;
    if (text[end] === ")" && --nesting === 0) return { label: text.slice(start + 1, labelEnd), image, end: end + 1 };
    if (text[end] === "\n") return null;
  }
  return null;
}

function appendAnswerInline(parent, text, technical = null, depth = 0, budget = { count: 0, characters: 0 }) {
  // Model HTML, links, and images remain inert text. Only our nodes and KaTeX
  // with trust:false can create markup; formulas are protected before emphasis.
  if (depth > 12) { parent.append(document.createTextNode(technical ? technical.restore(text) : text)); return; }
  if (!technical) {
    technical = protectAnswerTechnicalText(text, { code: false });
    text = technical.text;
  }
  let plain = "";
  const flush = () => { if (plain) { parent.append(document.createTextNode(plain)); plain = ""; } };
  for (let index = 0; index < text.length;) {
    const math = answerMaskedMathAt(text, index, technical);
    if (math) { flush(); parent.append(renderAnswerMath(math.token, budget)); index = math.end; continue; }
    const link = answerDisplayLinkAt(text, index);
    if (link) {
      flush();
      if (link.label) appendAnswerInline(parent, link.label, technical, depth + 1, budget);
      index = link.end; continue;
    }
    if (text[index] === "`") {
      const code = answerCodeTokenAt(text, index);
      if (code?.content !== undefined) {
        flush(); parent.append(element("code", { text: code.content })); index = code.end; continue;
      }
    }
    if (text[index] === "\\" && /[\\`*_{}\[\]()#+\-.!|$]/u.test(text[index + 1] || "")) {
      // Do not eat the opener of an incomplete formula while it is still text.
      plain += /[([]/u.test(text[index + 1]) ? text.slice(index, index + 2) : text[index + 1];
      index += 2; continue;
    }
    const marker = ["***", "___", "**", "__", "*", "_", "~~"].find((value) => text.startsWith(value, index));
    if (marker && !(marker[0] === "_" && /[\p{L}\p{N}]/u.test(text[index - 1] || ""))) {
      const end = answerEmphasisEnd(text, index + marker.length, marker);
      if (end > index + marker.length && text.slice(index + marker.length, end).trim()) {
        flush();
        const node = element(marker === "~~" ? "del" : marker.length > 1 ? "strong" : "em");
        const target = marker.length === 3 ? element("em") : node;
        appendAnswerInline(target, text.slice(index + marker.length, end), technical, depth + 1, budget);
        if (target !== node) node.append(target);
        parent.append(node); index = end + marker.length; continue;
      }
      plain += marker; index += marker.length; continue;
    }
    plain += text[index++];
  }
  flush();
}

function answerTableCells(line) {
  const text = line.trim();
  if (!text.includes("|")) return null;
  const cells = [];
  let cell = "";
  for (let index = 0; index < text.length;) {
    const token = (text[index] === "`" ? answerCodeTokenAt(text, index) : null) ||
      (text[index] === "\\" || text[index] === "$" ? answerMathTokenAt(text, index) : null);
    if (token) { cell += token.raw; index = token.end; }
    else if (text[index] === "\\" && text[index + 1] === "|") { cell += "\\|"; index += 2; }
    else if (text[index] === "|") { cells.push(cell.trim()); cell = ""; index += 1; }
    else cell += text[index++];
  }
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells.length >= 2 && cells.length <= 8 ? cells : null;
}

function answerTableAt(lines, index) {
  const header = answerTableCells(lines[index] || "");
  const divider = answerTableCells(lines[index + 1] || "");
  return header && divider && header.length === divider.length && divider.every((cell) => /^:?-{3,}:?$/u.test(cell))
    ? header : null;
}

function renderAnswerBody(answer) {
  const body = element("div", { className: "message-body answer-content" });
  const technical = protectAnswerTechnicalText(String(answer).replace(/\r\n?/gu, "\n"), { code: false });
  const lines = technical.text.split("\n");
  const budget = { count: 0, characters: 0 };
  const inline = (node, text) => appendAnswerInline(node, text, technical, 0, budget);
  const standaloneMath = (line) => {
    const trimmed = line.trim();
    const math = answerMaskedMathAt(trimmed, 0, technical);
    return math?.token.display && math.end === trimmed.length ? math.token : null;
  };
  const rule = (line) => /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line);
  const startsBlock = (index) => /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)、]\s|>|`{3,}|~{3,})/u.test(lines[index] || "") ||
    answerTableAt(lines, index) || standaloneMath(lines[index] || "") || rule(lines[index] || "");
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const math = standaloneMath(line);
    if (math) { body.append(renderAnswerMath(math, budget)); index += 1; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`, "u").test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const content = technical.restore(code.join("\n"));
      if (/^(?:math|latex|tex)$/iu.test(fence[2].trim())) {
        const wrapped = answerMathTokenAt(content.trim(), 0);
        body.append(renderAnswerMath({ raw: content, tex: wrapped?.end === content.trim().length ? wrapped.tex : content, display: true }, budget));
      } else body.append(element("pre", {}, [element("code", { text: content })]));
      continue;
    }
    const headers = answerTableAt(lines, index);
    if (headers) {
      const wrap = element("div", { className: "answer-table-scroll", attributes: { role: "region", "aria-label": "回答表格，可左右滑动", tabindex: "0" } });
      const table = element("table");
      const head = element("tr");
      const dividers = answerTableCells(lines[index + 1]);
      const cellNode = (tag, value, column) => {
        const node = element(tag, { attributes: tag === "th" ? { scope: "col" } : {} });
        const marker = dividers[column];
        if (marker.endsWith(":")) node.setAttribute("data-align", marker.startsWith(":") ? "center" : "right");
        inline(node, value); return node;
      };
      headers.forEach((value, column) => head.append(cellNode("th", value, column)));
      table.append(element("thead", {}, [head]));
      const rows = element("tbody");
      index += 2;
      while (index < lines.length) {
        const values = answerTableCells(lines[index]);
        if (!values || values.length !== headers.length) break;
        const row = element("tr");
        values.forEach((value, column) => row.append(cellNode("td", value, column)));
        rows.append(row); index += 1;
      }
      table.append(rows); wrap.append(table); body.append(wrap); continue;
    }
    if (rule(line)) { body.append(element("hr")); index += 1; continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/u);
    if (heading) { const node = element(`h${Math.min(6, heading[1].length + 2)}`); inline(node, heading[2]); body.append(node); index += 1; continue; }
    const listItem = line.match(/^\s*(?:([-+*])|(\d+)[.)、])\s+(.+)$/u);
    if (listItem) {
      const ordered = Boolean(listItem[2]);
      const list = element(ordered ? "ol" : "ul");
      if (ordered && Number(listItem[2]) > 1 && Number(listItem[2]) < 10_000) list.setAttribute("start", listItem[2]);
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-+*])|(\d+)[.)、])\s+(.+)$/u);
        if (!item || Boolean(item[2]) !== ordered) break;
        const node = element("li"); inline(node, item[3]); list.append(node); index += 1;
      }
      body.append(list); continue;
    }
    if (/^\s*>/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/u, ""));
      const node = element("blockquote"); inline(node, quote.join("\n")); body.append(node); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(index)) paragraph.push(lines[index++]);
    const node = element("p"); inline(node, paragraph.join("\n")); body.append(node);
  }
  return body;
}


function serviceLabel(service) {
  if (!service) return "正在连接…";
  if (!service.storageReady) return "资料服务暂不可用";
  if (!service.oaReady || !service.knowledgeReady || !service.retrievalReady) return "OA 知识暂不可用";
  return service.modelReady ? "基于 OA 审核公开资料回答" : "公开资料检索模式";
}

const SYSTEM_LIGHTS = Object.freeze([
  { key: "network", label: "网络" },
  { key: "oa", label: "OA" },
  { key: "qwen", label: "千问" },
  { key: "knowledge", label: "OA 知识" },
  { key: "system", label: "系统" },
]);
const SYSTEM_STATUS_REFRESH_MS = 60_000;
const SYSTEM_STATUS_RETRY_MS = 5_000;
const SYSTEM_STATUS_TIMEOUT_MS = 15_000;
const SUGGESTIONS_RETRY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60_000;
const CHAT_OA_PUBLIC_STATUSES = Object.freeze([
  "connected",
  "not_configured",
  "auth_error",
  "rate_limited",
  "timeout",
  "invalid_response",
  "unavailable",
]);

function emptyChatServiceEvidence() {
  return {
    storageReady: true,
    modelReady: false,
    qwenReady: false,
    modelPending: false,
    oaReady: false,
    knowledgeReady: false,
    retrievalReady: false,
    oaPending: false,
    budgetReady: false,
    systemReady: false,
    documentParsingReady: false,
    provider: null,
    model: null,
  };
}

function oaFailureMessage(status) {
  if (status === "not_configured") return "OA 知识服务未配置";
  if (status === "auth_error") return "OA 知识服务凭证校验失败";
  if (status === "rate_limited") return "OA 知识检索请求较多";
  if (status === "timeout") return "OA 知识检索响应超时";
  if (status === "invalid_response") return "OA 知识服务响应异常";
  return "OA 知识检索暂不可用";
}

function reconciledChatOaEvidence(service, payload, evidenceEpoch, currentEpoch) {
  const oaPublicStatus = payload?.oaPublicStatus;
  if (evidenceEpoch !== currentEpoch || !CHAT_OA_PUBLIC_STATUSES.includes(oaPublicStatus)) return null;
  const current = service || emptyChatServiceEvidence();
  const connected = oaPublicStatus === "connected";
  const configurationFailure = oaPublicStatus === "not_configured" || oaPublicStatus === "auth_error";
  const knowledgeReady = connected
    ? current.knowledgeReady === true || (Array.isArray(payload.sources) && payload.sources.length > 0)
    : configurationFailure
      ? false
      : current.knowledgeReady;
  const next = {
    ...current,
    oaReady: connected ? true : configurationFailure ? false : current.oaReady,
    knowledgeReady,
    retrievalReady: connected,
    oaPending: false,
    oaFailureStatus: connected ? null : oaPublicStatus,
  };
  next.systemReady = connected &&
    next.storageReady === true &&
    next.modelReady === true &&
    next.qwenReady === true &&
    knowledgeReady &&
    next.budgetReady === true;
  return {
    service: next,
    error: connected ? "" : oaFailureMessage(oaPublicStatus),
  };
}

function systemStatusRefreshPlan(service, retryDelay) {
  if (service?.systemReady === true && service.modelPending !== true && service.oaPending !== true) {
    return { delay: SYSTEM_STATUS_REFRESH_MS, nextRetryDelay: SYSTEM_STATUS_RETRY_MS };
  }
  const delay = Number.isFinite(retryDelay)
    ? Math.max(SYSTEM_STATUS_RETRY_MS, Math.min(SYSTEM_STATUS_REFRESH_MS, retryDelay))
    : SYSTEM_STATUS_RETRY_MS;
  return {
    delay,
    nextRetryDelay: Math.min(SYSTEM_STATUS_REFRESH_MS, delay * 2),
  };
}

function oaRetrievalStatusDetail(service) {
  if (service?.oaFailureStatus === "rate_limited") return "OA 检索请求较多";
  if (service?.oaFailureStatus === "timeout") return "OA 检索响应较慢";
  if (service?.oaFailureStatus === "invalid_response") return "OA 检索响应异常";
  return "OA 知识检索暂不可用";
}

function beijingDayKey(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp < 0) return "";
  return new Date(timestamp + BEIJING_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function suggestionsRefreshDelay(now = Date.now()) {
  const shiftedNow = now + BEIJING_UTC_OFFSET_MS;
  const nextBeijingDay = (Math.floor(shiftedNow / DAY_MS) + 1) * DAY_MS - BEIJING_UTC_OFFSET_MS;
  return Math.max(1_000, nextBeijingDay - now);
}

function suggestionsRefreshNeeded({ ready, loaded, loading, pending, fetchedAt, now }) {
  return ready === true &&
    loading !== true &&
    (
      loaded !== true ||
      pending === true ||
      beijingDayKey(now) !== beijingDayKey(fetchedAt)
    );
}

function createPublicApp() {
  document.documentElement.classList.add("public-chat-page");
  document.body.classList.add("public-chat-page");

  let historyStorage = null;
  try { historyStorage = window.localStorage; } catch { /* Chat works without browser storage. */ }
  let historySaveTimer = null;
  let historyDetail = null;

  function blankConversation(section, now = Date.now()) {
    const topic = CHAT_TOPICS.find((item) => item.id === section) || GENERAL_CHAT_TOPIC;
    return {
      id: makeRequestId(),
      section: topic.id,
      requestTopic: topic.requestTopic,
      title: "新聊天",
      createdAt: now,
      updatedAt: now,
      messages: [],
      conversationToken: "",
      tokenSavedAt: 0,
      draft: "",
      scrollTop: 0,
      stickToEnd: true,
      sending: false,
      error: "",
      notice: "",
    };
  }

  const initialSection = topicIdForPath(window.location.pathname);
  const storedConversations = readChatConversations(historyStorage, CHAT_TOPICS.map((topic) => topic.id));
  const conversations = storedConversations?.conversations || [];
  let migratedLegacyHistory = false;
  if (!storedConversations) {
    for (const topic of TOPICS) {
      const restored = readChatHistory(historyStorage, topic.id);
      if (!restored || (!restored.messages.length && !restored.draft)) continue;
      const conversation = blankConversation(topic.id, restored.savedAt || Date.now());
      Object.assign(conversation, restored, {
        title: chatConversationTitle(restored.messages),
        createdAt: restored.savedAt || Date.now(),
        updatedAt: restored.savedAt || Date.now(),
      });
      conversations.push(conversation);
      migratedLegacyHistory = true;
    }
  }
  let initialConversation = conversations.find((conversation) => (
    conversation.id === storedConversations?.activeConversationId && conversation.section === initialSection
  )) || conversations
    .filter((conversation) => conversation.section === initialSection)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!initialConversation) {
    initialConversation = blankConversation(initialSection);
    conversations.push(initialConversation);
  }

  const state = {
    section: initialConversation.section,
    conversations,
    activeConversationId: initialConversation.id,
    networkReady: null,
    service: null,
    serviceError: "",
    suggestions: [],
    suggestionsLoaded: false,
    suggestionsLoading: false,
    suggestionsFetchedAt: 0,
    inquiry: {
      name: "",
      organisation: "",
      contact: "",
      summary: "",
      includeConversation: false,
      consent: false,
      submitting: false,
      requestId: "",
      reference: "",
      error: "",
      section: "",
      conversationId: "",
    },
  };

  const analytics = createAnalyticsQueue();
  const mainSuggestionImpressions = new Set();
  const newChatSuggestionImpressions = new Set();
  const suggestionObservation = new WeakMap();
  let lastAnalyticsSection = "";
  let installSuccessTracked = false;
  const suggestionObserver = typeof window.IntersectionObserver === "function"
    ? new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target?.isConnected === false) {
          suggestionObserver.unobserve(entry.target);
          suggestionObservation.delete(entry.target);
          continue;
        }
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
        const metadata = suggestionObservation.get(entry.target);
        if (metadata && recordSuggestionImpression(entry.target, metadata)) {
          suggestionObserver.unobserve(entry.target);
          suggestionObservation.delete(entry.target);
        }
      }
    }, { threshold: 0.5 })
    : null;

  function trackPageView(section = state.section) {
    if (section === lastAnalyticsSection) return;
    lastAnalyticsSection = section;
    analytics.track("page_view", { section });
  }

  function trackInstallSuccessOnce() {
    if (installSuccessTracked) return;
    try {
      if (historyStorage?.getItem(CHAT_INSTALL_ANALYTICS_KEY) === "1") {
        installSuccessTracked = true;
        return;
      }
    } catch {
      // An unavailable local store only affects cross-launch deduplication.
    }
    if (!analytics.track("install_success", { section: state.section })) return;
    installSuccessTracked = true;
    try { historyStorage?.setItem(CHAT_INSTALL_ANALYTICS_KEY, "1"); } catch { /* Keep installation usable. */ }
  }

  function suggestionNodeVisible(node) {
    if (document.hidden === true || node?.isConnected === false) return false;
    if (typeof node?.getBoundingClientRect !== "function") return true;
    const rect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
      rect.left < viewportWidth && rect.top < viewportHeight;
  }

  function recordSuggestionImpression(node, metadata) {
    if (!suggestionNodeVisible(node)) return false;
    if (metadata.surface === "composer") {
      const session = conversationFor(metadata.conversationId);
      if (state.activeConversationId !== metadata.conversationId || suggestionPanel.hidden ||
          !session || session.messages.length > 0 || session.sending ||
          !state.suggestions.includes(metadata.suggestion)) return false;
      const key = `${beijingDayKey(Date.now())}:${metadata.conversationId}:${metadata.suggestion}`;
      if (mainSuggestionImpressions.has(key)) return true;
      mainSuggestionImpressions.add(key);
    } else {
      if (!newChatDialog.open || metadata.dialogEpoch !== newChatDialogEpoch ||
          newChatSuggestionPanel.hidden || !state.suggestions.includes(metadata.suggestion)) return false;
      const key = `${metadata.dialogEpoch}:${metadata.suggestion}`;
      if (newChatSuggestionImpressions.has(key)) return true;
      newChatSuggestionImpressions.add(key);
    }
    analytics.track("suggestion_impression", {
      section: metadata.section,
      suggestion: metadata.suggestion,
    });
    return true;
  }

  function observeSuggestionImpression(node, metadata) {
    suggestionObservation.set(node, metadata);
    if (suggestionObserver) {
      suggestionObserver.observe(node);
      return;
    }
    window.requestAnimationFrame(() => { recordSuggestionImpression(node, metadata); });
  }

  function clearSuggestionList(list) {
    if (suggestionObserver) {
      for (const node of list.children) {
        suggestionObserver.unobserve(node);
        suggestionObservation.delete(node);
      }
    }
    list.replaceChildren();
  }

  function observeOpenNewChatSuggestions(dialogEpoch) {
    if (!newChatDialog.open || dialogEpoch !== newChatDialogEpoch || newChatSuggestionPanel.hidden) return;
    for (const [index, button] of Array.from(newChatSuggestionList.children).entries()) {
      const suggestion = state.suggestions[index];
      if (!suggestion) continue;
      observeSuggestionImpression(button, {
        surface: "new_chat",
        section: newChatSection,
        suggestion,
        dialogEpoch,
      });
    }
  }

  if (migratedLegacyHistory && writeChatConversations(
    historyStorage,
    state.conversations,
    state.activeConversationId,
  )) {
    for (const topic of TOPICS) {
      try { historyStorage?.removeItem(CHAT_HISTORY_KEY + topic.id); } catch { /* Keep chat usable. */ }
    }
  }

  function persistSession() {
    if (historySaveTimer !== null) window.clearTimeout(historySaveTimer);
    historySaveTimer = null;
    const saved = writeChatConversations(
      historyStorage,
      state.conversations,
      state.activeConversationId,
    );
    if (historyDetail) historyDetail.textContent = saved
      ? "对话和草稿仅保存在当前浏览器，保留 7 天。删除聊天会同时删除本机保存的对应记录。"
      : "当前浏览器无法保存对话，刷新后可能丢失。你仍可继续聊天或复制回答。";
  }

  function scheduleHistorySave() {
    if (historySaveTimer !== null) window.clearTimeout(historySaveTimer);
    historySaveTimer = window.setTimeout(persistSession, 300);
  }

  function flushHistory() {
    saveCurrentView();
    persistSession();
  }

  function topicFor(section = state.section) {
    return CHAT_TOPICS.find((topic) => topic.id === section) || GENERAL_CHAT_TOPIC;
  }

  function conversationFor(conversationId) {
    return state.conversations.find((conversation) => conversation.id === conversationId) || null;
  }

  function sessionFor(section = state.section) {
    const active = conversationFor(state.activeConversationId);
    if (active?.section === section) return active;
    return state.conversations
      .filter((conversation) => conversation.section === section)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || active || state.conversations[0];
  }

  function hasResettableState(session) {
    return Boolean(session.messages.length || session.draft || session.error || session.notice);
  }

  const app = element("div", { className: "chat-app" });
  const header = element("header", { className: "topbar site-header" });
  const menuButton = textButton("", "menu-button");
  menuButton.setAttribute("aria-label", "打开导航菜单");
  menuButton.setAttribute("aria-controls", "topic-drawer");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.append(element("span", {
    className: "menu-glyph",
    attributes: { "aria-hidden": "true" },
  }, [
    element("span", { className: "menu-line" }),
    element("span", { className: "menu-line" }),
  ]));
  const topicTitle = element("h1", { className: "topic-title", text: "聊天" });
  const topicSubtitle = element("p", { className: "topic-subtitle", text: "实验室大模型" });
  const systemStatus = textButton("", "system-status-strip");
  systemStatus.setAttribute("aria-label", "系统连接状态：正在检测");
  systemStatus.setAttribute("aria-controls", "system-status-details");
  systemStatus.setAttribute("aria-expanded", "false");
  systemStatus.setAttribute("title", "系统连接状态：正在检测");
  const systemStatusDetails = element("div", {
    id: "system-status-details",
    className: "system-status-details",
    attributes: { role: "region", "aria-label": "系统连接详情" },
  });
  systemStatusDetails.hidden = true;
  systemStatusDetails.append(element("strong", {
    className: "system-status-details-title",
    text: "系统连接详情",
  }));
  const systemStatusDetailsList = element("div", { className: "system-status-details-list" });
  systemStatusDetails.append(systemStatusDetailsList);
  const systemStatusAnnouncement = element("span", {
    className: "sr-only",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const systemLightNodes = new Map();
  for (const light of SYSTEM_LIGHTS) {
    const detail = element("span", { className: "sr-only", text: `${light.label}：正在检测` });
    const dot = element("span", {
      className: "system-light-dot is-pending",
      attributes: { "aria-hidden": "true" },
    });
    const item = element("span", {
      className: "system-light",
      attributes: { title: `${light.label}：正在检测` },
    }, [dot, detail]);
    const panelDetail = element("span", {
      className: "system-status-detail-value",
      text: "正在检测",
    });
    const panelRow = element("div", {
      className: "system-status-detail-row is-pending",
    }, [
      element("span", { className: "system-status-detail-label", text: light.label }),
      panelDetail,
    ]);
    systemLightNodes.set(light.key, { item, dot, detail, panelDetail, panelRow });
    systemStatus.append(item);
    systemStatusDetailsList.append(panelRow);
  }
  const topicHeader = element("div", { className: "topic-header" }, [
    topicTitle,
    topicSubtitle,
    systemStatus,
    systemStatusDetails,
    systemStatusAnnouncement,
  ]);

  function useCapability(command) {
    const current = questionInput.value.trim();
    questionInput.value = current ? `${command} ${current}` : `${command} `;
    questionInput.dispatchEvent(new Event("input", { bubbles: true }));
    questionInput.focus({ preventScroll: true });
  }

  function setSystemStatusDetailsOpen(open) {
    const nextOpen = open === true;
    systemStatusDetails.hidden = !nextOpen;
    systemStatus.setAttribute("aria-expanded", String(nextOpen));
  }

  systemStatus.addEventListener("click", () => {
    setSystemStatusDetailsOpen(systemStatusDetails.hidden);
  });
  document.addEventListener("click", (event) => {
    if (!systemStatusDetails.hidden && !topicHeader.contains(event.target)) {
      setSystemStatusDetailsOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || systemStatusDetails.hidden) return;
    setSystemStatusDetailsOpen(false);
    systemStatus.focus({ preventScroll: true });
  });
  const chatInfoButton = textButton("", "chat-info-button");
  chatInfoButton.setAttribute("aria-label", "聊天信息");
  chatInfoButton.setAttribute("aria-controls", "chat-info-dialog");
  chatInfoButton.setAttribute("aria-haspopup", "dialog");
  chatInfoButton.setAttribute("aria-expanded", "false");
  chatInfoButton.append(element("span", {
    className: "more-glyph",
    attributes: { "aria-hidden": "true" },
  }, [
    element("span", { className: "more-dot" }),
    element("span", { className: "more-dot" }),
    element("span", { className: "more-dot" }),
  ]));
  const statusText = element("span", {
    className: "sr-only",
    text: serviceLabel(null),
    attributes: { role: "status", "aria-live": "polite" },
  });
  const topicStatus = element("span", {
    className: "sr-only",
    attributes: { role: "status", "aria-live": "polite" },
  });
  header.append(menuButton, topicHeader, chatInfoButton, statusText, topicStatus);

  const topicLinks = new Map(TOPICS.map((topic) => [topic.id, []]));
  const recentLists = [];
  const chatLaunchButtons = [];
  const installControls = [];
  let deferredInstallPrompt = null;
  let installDialogOpener = null;
  let installedWebApp = isStandaloneWebApp();

  function sidebarContent({ mobile = false } = {}) {
    const shell = element("div", { className: "sidebar-shell" });
    const sidebarHeader = element("div", { className: "sidebar-header" });
    const sidebarBrand = element("div", { className: "sidebar-brand" }, [
      element("strong", { className: "sidebar-brand-title", text: OA_PREVIEW_NAME }),
      element("span", { className: "sidebar-brand-subtitle", text: OA_PREVIEW_BRAND }),
    ]);
    const sidebarSearch = textButton("⌕", "sidebar-search");
    sidebarSearch.setAttribute("aria-label", "搜索最近聊天");
    sidebarSearch.addEventListener("click", searchRecentConversations);
    sidebarHeader.append(sidebarBrand, sidebarSearch);
    if (mobile) {
      sidebarBrand.id = "topic-drawer-title";
      const close = textButton("×", "drawer-close");
      close.setAttribute("aria-label", "关闭聊天侧栏");
      close.addEventListener("click", closeTopicDrawer);
      sidebarHeader.append(close);
    }

    const pinnedLabel = element("p", {
      className: "sidebar-section-label",
      text: "大模型与资料",
    });
    const pinned = element("nav", {
      className: "sidebar-topic-list",
      attributes: { "aria-label": "置顶知识域" },
    });
    for (const topic of TOPICS) {
      const link = element("a", {
        className: "sidebar-topic-link",
        attributes: { href: topic.path },
      });
      link.append(
        element("span", { className: "sidebar-folder-icon", attributes: { "aria-hidden": "true" } }),
        element("span", { text: topic.title }),
      );
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        activateTopic(topic.id, { historyMode: "push", announce: true });
        closeTopicDrawer();
      });
      topicLinks.get(topic.id).push(link);
      pinned.append(link);
    }

    const recentLabel = element("p", {
      className: "sidebar-section-label sidebar-recent-label",
      text: "最近聊天",
    });
    const recentList = element("div", {
      className: "sidebar-recent-list",
      attributes: { role: "list", "aria-label": "最近聊天" },
    });
    recentLists.push(recentList);

    const sidebarBottom = element("div", { className: "sidebar-bottom" });
    const utilityLinks = element("div", { className: "sidebar-utility-links" });
    const officialLink = externalLink("官网", OFFICIAL_SITE, "sidebar-utility-link");
    const oaLink = externalLink("进入 OA", OA_KNOWLEDGE_URL, "sidebar-utility-link");
    const manageLink = element("a", {
      className: "sidebar-utility-link",
      attributes: { href: "/manage" },
      text: "管理",
    });
    const installButton = textButton("", "sidebar-install-button");
    const installLabel = element("span", { text: "安装应用" });
    installButton.append(
      icon("⇩", "sidebar-install-icon"),
      installLabel,
    );
    installButton.setAttribute("aria-controls", "install-dialog");
    installButton.setAttribute("aria-haspopup", "dialog");
    installButton.addEventListener("click", () => { void requestAppInstall(installButton); });
    installControls.push({ button: installButton, label: installLabel });
    if (officialLink) utilityLinks.append(officialLink);
    if (oaLink) utilityLinks.append(oaLink);
    utilityLinks.append(manageLink, installButton);
    const bottomRow = element("div", { className: "sidebar-bottom-row" });
    const chatButton = textButton("", "sidebar-chat-button");
    chatButton.setAttribute("aria-controls", "new-chat-dialog");
    chatButton.setAttribute("aria-haspopup", "dialog");
    chatButton.setAttribute("aria-expanded", "false");
    chatButton.append(icon("＋", "sidebar-chat-icon"), element("span", { text: "聊天" }));
    chatButton.addEventListener("click", () => openNewChat(chatButton));
    chatLaunchButtons.push(chatButton);
    bottomRow.append(
      chatButton,
      element("span", {
        className: "sidebar-avatar",
        text: "GM",
        attributes: { "aria-label": "当前用户 GM" },
      }),
    );
    sidebarBottom.append(utilityLinks, bottomRow);
    shell.append(sidebarHeader, pinnedLabel, pinned, recentLabel, recentList, sidebarBottom);
    return shell;
  }

  const desktopSidebar = element("aside", {
    className: "chat-sidebar",
    attributes: { "aria-label": "聊天侧栏" },
  });
  desktopSidebar.append(sidebarContent());

  const topicDrawer = element("dialog", {
    id: "topic-drawer",
    className: "topic-drawer",
    attributes: { "aria-labelledby": "topic-drawer-title" },
  });
  const drawerPanel = element("div", { className: "drawer-panel" });
  drawerPanel.append(sidebarContent({ mobile: true }));
  topicDrawer.append(drawerPanel);

  function closeTopicDrawer() {
    if (!topicDrawer.open) return;
    menuButton.setAttribute("aria-expanded", "false");
    topicDrawer.close();
  }

  menuButton.addEventListener("click", () => {
    if (topicDrawer.open) return;
    menuButton.setAttribute("aria-expanded", "true");
    topicDrawer.showModal();
    window.requestAnimationFrame(() => (
      topicLinks.get(state.section)?.at(-1) || topicLinks.get(TOPICS[0].id)?.at(-1)
    )?.focus());
  });
  topicDrawer.addEventListener("click", (event) => {
    if (event.target === topicDrawer) closeTopicDrawer();
  });
  topicDrawer.addEventListener("cancel", () => {
    menuButton.setAttribute("aria-expanded", "false");
  });
  topicDrawer.addEventListener("close", () => {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.focus();
  });

  const layout = element("main", { className: "chat-layout" });
  const conversation = element("section", {
    className: "conversation",
    attributes: { "aria-label": "咨询对话" },
  });

  const messageScroll = element("div", {
    className: "message-scroll",
    attributes: {
      tabindex: "0",
      role: "log",
      "aria-label": "对话内容",
      "aria-live": "polite",
      "aria-relevant": "additions text",
      "aria-busy": "false",
    },
  });
  const composerArea = element("div", { className: "composer-area" });
  const errorRegion = element("p", {
    className: "error",
    attributes: { role: "alert", "aria-live": "assertive" },
  });
  const noticeRegion = element("p", {
    className: "small-note composer-notice",
    attributes: { role: "status", "aria-live": "polite" },
  });
  errorRegion.hidden = true;
  noticeRegion.hidden = true;

  const suggestionPanel = element("section", {
    className: "composer-suggestions",
    attributes: { "aria-label": "知识库推荐话题" },
  });
  const suggestionList = element("div", {
    className: "suggestions",
    attributes: { role: "group" },
  });
  const suggestionCaption = element("p", {
    className: "suggestion-caption",
    text: "今日推荐 · 基于公开知识，每日更新",
  });
  suggestionPanel.hidden = true;
  suggestionPanel.append(suggestionCaption, suggestionList);

  const composer = element("form", { className: "composer" });
  const questionLabel = element("label", {
    className: "sr-only",
    text: "你的问题",
    attributes: { for: "question" },
  });
  const questionInput = element("textarea", {
    id: "question",
    attributes: {
      maxlength: "2000",
      rows: "1",
      placeholder: "询问实验室大数据",
      autocomplete: "off",
    },
  });
  const sendButton = textButton("发送", "send-button");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "发送问题");
  sendButton.disabled = true;
  composer.append(questionLabel, questionInput, sendButton);
  composerArea.append(errorRegion, noticeRegion, composer);
  conversation.append(messageScroll, suggestionPanel, composerArea);
  layout.append(conversation);

  const newChatDialog = element("dialog", {
    id: "new-chat-dialog",
    className: "new-chat-dialog",
    attributes: { "aria-labelledby": "new-chat-title" },
  });
  const newChatPanel = element("div", { className: "new-chat-panel" });
  const newChatHeader = element("header", { className: "new-chat-header" });
  const newChatTitle = element("h2", { id: "new-chat-title", text: "新建聊天" });
  const newChatClose = textButton("×", "new-chat-close");
  newChatClose.setAttribute("aria-label", "关闭新建聊天");
  newChatHeader.append(newChatTitle, newChatClose);
  const newChatContextValue = element("strong", { text: GENERAL_CHAT_TOPIC.detail });
  const newChatContext = element("p", { className: "new-chat-context" }, [
    "当前知识范围：",
    newChatContextValue,
  ]);
  const newChatSuggestionPanel = element("section", {
    className: "new-chat-suggestions",
    attributes: { "aria-label": "新聊天推荐话题" },
  });
  const newChatSuggestionList = element("div", {
    className: "new-chat-suggestion-list",
    attributes: { role: "group" },
  });
  const newChatSuggestionCaption = element("p", {
    className: "new-chat-suggestion-caption",
    text: "今日推荐 · 基于公开知识，每日更新",
  });
  newChatSuggestionPanel.append(newChatSuggestionCaption, newChatSuggestionList);
  const newChatForm = element("form", { className: "new-chat-form" });
  const newChatInputLabel = element("label", {
    className: "sr-only",
    text: "新聊天问题",
    attributes: { for: "new-chat-question" },
  });
  const newChatInput = element("textarea", {
    id: "new-chat-question",
    className: "new-chat-input",
    attributes: {
      maxlength: "2000",
      rows: "2",
      placeholder: "询问实验室大数据",
      autocomplete: "off",
    },
  });
  const newChatSend = textButton("↑", "new-chat-send");
  newChatSend.type = "submit";
  newChatSend.disabled = true;
  newChatSend.setAttribute("aria-label", "开始聊天并发送问题");
  newChatForm.append(newChatInputLabel, newChatInput, newChatSend);
  newChatPanel.append(newChatHeader, newChatContext, newChatSuggestionPanel, newChatForm);
  newChatDialog.append(newChatPanel);

  let newChatDialogOpener = null;
  let newChatSection = GENERAL_CHAT_TOPIC.id;
  let newChatDialogEpoch = 0;

  function finishNewChatClose() {
    newChatDialogEpoch += 1;
    for (const button of chatLaunchButtons) button.setAttribute("aria-expanded", "false");
    const opener = newChatDialogOpener;
    newChatDialogOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    syncChatViewport();
  }

  function closeNewChat() {
    if (!newChatDialog.open) return;
    newChatDialog.close();
  }

  function openNewChat(opener) {
    if (newChatDialog.open) return;
    const resolvedOpener = topicDrawer.contains(opener) ? menuButton : opener;
    closeTopicDrawer();
    newChatDialogOpener = resolvedOpener instanceof HTMLElement ? resolvedOpener : document.activeElement;
    newChatSection = GENERAL_CHAT_TOPIC.id;
    newChatContextValue.textContent = GENERAL_CHAT_TOPIC.detail;
    newChatInput.value = "";
    newChatSend.disabled = true;
    newChatDialogEpoch += 1;
    renderNewChatSuggestions();
    for (const button of chatLaunchButtons) button.setAttribute("aria-expanded", "true");
    newChatDialog.showModal();
    window.requestAnimationFrame(() => {
      newChatInput.focus({ preventScroll: true });
      syncChatViewport();
      observeOpenNewChatSuggestions(newChatDialogEpoch);
    });
  }

  newChatClose.addEventListener("click", closeNewChat);
  newChatDialog.addEventListener("click", (event) => {
    if (event.target === newChatDialog) closeNewChat();
  });
  newChatDialog.addEventListener("cancel", () => {
    for (const button of chatLaunchButtons) button.setAttribute("aria-expanded", "false");
  });
  newChatDialog.addEventListener("close", finishNewChatClose);
  newChatInput.addEventListener("input", () => {
    newChatSend.disabled = !newChatInput.value.trim();
  });
  newChatInput.addEventListener("focus", syncChatViewport);
  newChatInput.addEventListener("blur", syncChatViewport);
  newChatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      startNewChatQuestion(newChatInput.value);
    }
  });
  newChatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    startNewChatQuestion(newChatInput.value);
  });

  const installDialog = element("dialog", {
    id: "install-dialog",
    className: "install-dialog",
    attributes: {
      "aria-labelledby": "install-dialog-title",
      "aria-describedby": "install-dialog-description",
    },
  });
  const installPanel = element("div", { className: "install-panel" });
  const installHeader = element("header", { className: "install-header" });
  const installTitle = element("h2", { id: "install-dialog-title", text: "安装联合研发 OA" });
  const installClose = textButton("×", "install-close");
  installClose.setAttribute("aria-label", "关闭安装说明");
  installHeader.append(installTitle, installClose);
  const installDescription = element("p", {
    id: "install-dialog-description",
    className: "install-description",
  });
  const installSteps = element("ol", { className: "install-steps" });
  const installDone = textButton("知道了", "install-done");
  installPanel.append(installHeader, installDescription, installSteps, installDone);
  installDialog.append(installPanel);

  function updateInstallControls() {
    installedWebApp = installedWebApp || isStandaloneWebApp();
    for (const { button, label } of installControls) {
      button.disabled = installedWebApp;
      label.textContent = installedWebApp ? "已安装" : "安装应用";
      button.setAttribute("aria-label", installedWebApp ? "联合研发 OA 已安装" : "安装联合研发 OA");
      button.setAttribute("aria-haspopup", installedWebApp ? "false" : "dialog");
    }
  }

  function finishInstallDialogClose() {
    const opener = installDialogOpener;
    installDialogOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function closeInstallDialog() {
    if (installDialog.open) installDialog.close();
  }

  function openInstallGuidance(opener) {
    installDialogOpener = topicDrawer.contains(opener) ? menuButton : opener;
    closeTopicDrawer();
    installSteps.replaceChildren();
    if (isAppleMobileDevice()) {
      installTitle.textContent = "添加到主屏幕";
      installDescription.textContent = "iPhone 和 iPad 需要通过 Safari 的系统菜单完成安装。";
      for (const step of ["点击 Safari 的分享按钮", "选择“添加到主屏幕”", "确认“作为网页 App 打开”，再点击“添加”"]) {
        installSteps.append(element("li", { text: step }));
      }
    } else {
      installTitle.textContent = "安装联合研发 OA";
      installDescription.textContent = "当前浏览器暂未提供站内安装确认。你仍可通过浏览器菜单添加到桌面。";
      for (const step of ["打开浏览器菜单", "选择“安装应用”或“添加到桌面”", "按系统提示确认"]) {
        installSteps.append(element("li", { text: step }));
      }
    }
    if (!installDialog.open) installDialog.showModal();
    window.requestAnimationFrame(() => installClose.focus({ preventScroll: true }));
  }

  async function requestAppInstall(opener) {
    if (installedWebApp || isStandaloneWebApp()) {
      installedWebApp = true;
      updateInstallControls();
      topicStatus.textContent = "联合研发 OA 已作为桌面应用打开";
      return;
    }
    const promptEvent = deferredInstallPrompt;
    if (!promptEvent || typeof promptEvent.prompt !== "function") {
      openInstallGuidance(opener);
      return;
    }
    closeTopicDrawer();
    deferredInstallPrompt = null;
    updateInstallControls();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === "accepted") {
        topicStatus.textContent = "正在安装联合研发 OA";
      }
    } catch {
      openInstallGuidance(opener);
    }
  }

  installClose.addEventListener("click", closeInstallDialog);
  installDone.addEventListener("click", closeInstallDialog);
  installDialog.addEventListener("click", (event) => {
    if (event.target === installDialog) closeInstallDialog();
  });
  installDialog.addEventListener("close", finishInstallDialogClose);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault?.();
    deferredInstallPrompt = event;
    updateInstallControls();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installedWebApp = true;
    trackInstallSuccessOnce();
    updateInstallControls();
    closeInstallDialog();
    topicStatus.textContent = "联合研发 OA 已安装到桌面";
  });
  updateInstallControls();

  function chatInfoActionRow(labelText, action, extraClass = "") {
    const row = textButton("", `chat-info-row${extraClass ? ` ${extraClass}` : ""}`);
    row.append(
      element("span", { className: "chat-info-label", text: labelText }),
      element("span", {
        className: "chat-info-chevron",
        text: "›",
        attributes: { "aria-hidden": "true" },
      }),
    );
    row.addEventListener("click", action);
    return row;
  }

  const chatInfoDialog = element("dialog", {
    id: "chat-info-dialog",
    className: "chat-info-dialog",
    attributes: { "aria-labelledby": "chat-info-title" },
  });
  const chatInfoPage = element("div", { className: "chat-info-page" });
  const chatInfoHeader = element("header", { className: "chat-info-header" });
  const chatInfoBack = textButton("", "chat-info-back");
  chatInfoBack.setAttribute("aria-label", "返回聊天");
  chatInfoBack.append(element("span", {
    className: "chat-info-back-glyph",
    text: "‹",
    attributes: { "aria-hidden": "true" },
  }));
  chatInfoHeader.append(
    chatInfoBack,
    element("h2", { id: "chat-info-title", text: "聊天信息" }),
    element("span", {
      className: "chat-info-header-balance",
      attributes: { "aria-hidden": "true" },
    }),
  );

  const chatInfoScroll = element("div", { className: "chat-info-scroll" });
  const chatInfoMembers = element("section", { className: "chat-info-block chat-info-members" });
  const chatInfoMember = element("div", { className: "chat-info-member" });
  chatInfoMember.append(
    element("img", {
      className: "chat-info-avatar",
      attributes: { src: "/favicon.svg", alt: "" },
    }),
    element("span", { className: "chat-info-member-name", text: APP_NAME }),
  );
  chatInfoMembers.append(chatInfoMember);

  const chatInfoSearchBlock = element("section", { className: "chat-info-block" });
  chatInfoSearchBlock.append(chatInfoActionRow("查找聊天记录", findChatMessage));

  const chatInfoClearBlock = element("section", { className: "chat-info-block" });
  const clearChatHistory = chatInfoActionRow("清空聊天记录", () => {
    const session = sessionFor();
    if (session.sending || !hasResettableState(session)) return;
    if (!window.confirm("确定清空当前聊天记录吗？")) return;
    resetCurrentConversation({ closeInfo: true });
  }, "chat-info-clear");
  chatInfoClearBlock.append(clearChatHistory);

  historyDetail = element("p", {
    className: "chat-history-detail",
    text: historyStorage
      ? "对话和草稿仅保存在当前浏览器，保留 7 天。删除聊天会同时删除本机保存的对应记录。"
      : "当前浏览器无法保存对话，刷新后可能丢失。你仍可继续聊天或复制回答。",
  });
  chatInfoClearBlock.append(historyDetail);

  chatInfoScroll.append(
    chatInfoMembers,
    chatInfoSearchBlock,
    chatInfoClearBlock,
  );
  chatInfoPage.append(chatInfoHeader, chatInfoScroll);
  chatInfoDialog.append(chatInfoPage);

  let chatInfoDialogOpener = null;
  chatInfoButton.addEventListener("click", openChatInfo);
  chatInfoBack.addEventListener("click", () => closeChatInfo());
  chatInfoDialog.addEventListener("cancel", () => {
    chatInfoButton.setAttribute("aria-expanded", "false");
  });
  chatInfoDialog.addEventListener("close", () => {
    chatInfoButton.setAttribute("aria-expanded", "false");
    syncChatViewport();
    const opener = chatInfoDialogOpener;
    chatInfoDialogOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });

  const inquiryDialog = element("dialog", {
    className: "content-dialog inquiry-dialog",
    attributes: {
      "aria-labelledby": "inquiry-dialog-title",
      "aria-describedby": "inquiry-dialog-description",
    },
  });
  let inquiryDialogOpener = null;
  let renderEpoch = 0;
  inquiryDialog.addEventListener("close", () => {
    state.inquiry.reference = "";
    state.inquiry.error = "";
    const opener = inquiryDialogOpener;
    inquiryDialogOpener = null;
    if (opener?.isConnected) opener.focus();
  });

  app.append(
    desktopSidebar,
    header,
    layout,
    topicDrawer,
    newChatDialog,
    installDialog,
    chatInfoDialog,
    inquiryDialog,
  );
  root.replaceChildren(app);

  let systemStatusEpoch = 0;
  let systemStatusController = null;
  let systemStatusCheckedAt = 0;
  let systemStatusRefreshTimer = null;
  let systemStatusRefreshDueAt = 0;
  let systemStatusRetryDelay = SYSTEM_STATUS_RETRY_MS;
  let suggestionsRefreshTimer = null;
  let suggestionsRefreshDueAt = 0;
  let suggestionsRefreshPending = false;
  let suggestionsEpoch = 0;
  let announcedSystemDescription = "";

  function knowledgeRetrievalReady() {
    return state.networkReady === true &&
      state.service?.knowledgeReady === true &&
      state.service?.retrievalReady === true;
  }

  function recommendationsReady() {
    return knowledgeRetrievalReady() && systemStatusController === null;
  }

  function invalidateSuggestions() {
    suggestionsEpoch += 1;
    if (suggestionsRefreshTimer !== null) window.clearTimeout(suggestionsRefreshTimer);
    suggestionsRefreshTimer = null;
    suggestionsRefreshDueAt = 0;
    suggestionsRefreshPending = false;
    state.suggestions = [];
    state.suggestionsLoaded = false;
    state.suggestionsLoading = false;
  }

  function setSystemLight(key, tone, detail) {
    const nodes = systemLightNodes.get(key);
    if (!nodes) return;
    nodes.dot.className = `system-light-dot is-${tone}`;
    nodes.item.setAttribute("title", `${SYSTEM_LIGHTS.find((light) => light.key === key)?.label || key}：${detail}`);
    nodes.detail.textContent = `${SYSTEM_LIGHTS.find((light) => light.key === key)?.label || key}：${detail}`;
    nodes.panelRow.className = `system-status-detail-row is-${tone}`;
    nodes.panelDetail.textContent = detail;
  }

  function updateSystemLights() {
    const service = state.service;
    const details = [];
    const networkTone = state.networkReady === null ? "pending" : state.networkReady ? "ok" : "error";
    const networkDetail = state.networkReady === null ? "正在检测" : state.networkReady ? "已连接" : "连接异常";
    setSystemLight("network", networkTone, networkDetail);
    details.push(`网络：${networkDetail}`);

    const unavailable = !service || state.networkReady === false;
    const oaTone = unavailable || service.oaPending ? "pending" : service.oaReady ? "ok" : "error";
    const oaDetail = unavailable || service.oaPending ? "正在检测" : service.oaReady ? "已连接" : "连接异常";
    setSystemLight("oa", oaTone, oaDetail);
    details.push(`OA：${oaDetail}`);

    const qwenTone = unavailable || service.modelPending ? "pending" : service.qwenReady ? "ok" : "error";
    const qwenDetail = unavailable || service.modelPending ? "正在检测" : service.qwenReady ? "已连接" : "连接异常";
    setSystemLight("qwen", qwenTone, qwenDetail);
    details.push(`千问：${qwenDetail}`);

    const knowledgeReady = service?.knowledgeReady === true && service?.retrievalReady === true;
    const knowledgeTone = unavailable || service.oaPending ? "pending" : knowledgeReady ? "ok" : "error";
    const knowledgeDetail = unavailable || service.oaPending
      ? "正在检测"
      : knowledgeReady
        ? "OA 知识可检索"
        : service.knowledgeReady === true
          ? oaRetrievalStatusDetail(service)
          : "OA 公开知识不可用";
    setSystemLight("knowledge", knowledgeTone, knowledgeDetail);
    details.push(`知识：${knowledgeDetail}`);

    const servicePending = unavailable || service.modelPending || service.oaPending;
    const allReady = !servicePending &&
      state.networkReady === true &&
      service.oaReady === true &&
      service.qwenReady === true &&
      knowledgeReady &&
      service.budgetReady === true &&
      service.systemReady === true;
    const systemTone = servicePending ? "pending" : allReady ? "ok" : "error";
    const systemDetail = servicePending
      ? "正在检测"
      : allReady
        ? "运行正常"
        : service.budgetReady === false
          ? "今日 AI 额度已用完"
          : service.oaReady === true && service.retrievalReady === false
            ? oaRetrievalStatusDetail(service)
            : "运行异常";
    setSystemLight("system", systemTone, systemDetail);
    details.push(`系统：${systemDetail}`);

    const readyCount = [
      state.networkReady === true,
      service?.oaReady === true,
      service?.qwenReady === true,
      knowledgeReady,
      allReady,
    ].filter(Boolean).length;
    const summary = allReady
      ? "系统运行正常 · 5/5"
      : servicePending
        ? "系统连接状态：正在检测"
        : `部分服务异常 · ${readyCount}/5`;
    const description = `${summary}；${details.join("；")}`;
    systemStatus.setAttribute("aria-label", description);
    systemStatus.setAttribute("title", description);
    if (description !== announcedSystemDescription) {
      announcedSystemDescription = description;
      systemStatusAnnouncement.textContent = description;
    }
    if (!knowledgeRetrievalReady()) {
      invalidateSuggestions();
    } else if (suggestionsRefreshNeeded({
      ready: recommendationsReady(),
      loaded: state.suggestionsLoaded,
      loading: state.suggestionsLoading,
      pending: suggestionsRefreshPending,
      fetchedAt: state.suggestionsFetchedAt,
      now: Date.now(),
    })) {
      void loadSuggestions({ force: state.suggestionsLoaded });
    }
    renderSuggestions();
  }

  async function probeNetwork(signal) {
    if (navigator.onLine === false) return false;
    try {
      const response = await fetch("/_health", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload?.ready === true;
    } catch {
      return false;
    }
  }

  function reconcileChatOaStatus(payload, evidenceEpoch) {
    const reconciled = reconciledChatOaEvidence(
      state.service,
      payload,
      evidenceEpoch,
      systemStatusEpoch,
    );
    if (!reconciled) {
      if (evidenceEpoch === systemStatusEpoch) scheduleNextSystemStatusRefresh();
      return;
    }
    state.service = reconciled.service;
    state.serviceError = reconciled.error;
    statusText.textContent = serviceLabel(state.service);
    updateSystemLights();
    systemStatusRetryDelay = SYSTEM_STATUS_RETRY_MS;
    scheduleNextSystemStatusRefresh();
  }

  function scheduleSystemStatusRefresh(delay = SYSTEM_STATUS_REFRESH_MS) {
    if (systemStatusRefreshTimer !== null) window.clearTimeout(systemStatusRefreshTimer);
    systemStatusRefreshDueAt = Date.now() + delay;
    systemStatusRefreshTimer = window.setTimeout(() => {
      systemStatusRefreshTimer = null;
      if (document.hidden) {
        systemStatusRefreshDueAt = Date.now();
        return;
      }
      systemStatusRefreshDueAt = 0;
      void loadSystemStatus();
    }, delay);
  }

  function scheduleNextSystemStatusRefresh() {
    const plan = systemStatusRefreshPlan(state.service, systemStatusRetryDelay);
    systemStatusRetryDelay = plan.nextRetryDelay;
    scheduleSystemStatusRefresh(plan.delay);
  }

  async function loadSystemStatus({ showPending = false } = {}) {
    if (systemStatusController) return;
    if (systemStatusRefreshTimer !== null) window.clearTimeout(systemStatusRefreshTimer);
    systemStatusRefreshTimer = null;
    systemStatusRefreshDueAt = 0;
    const epoch = ++systemStatusEpoch;
    const controller = new AbortController();
    systemStatusController = controller;
    renderSuggestions();
    const timeout = window.setTimeout(() => controller.abort(), SYSTEM_STATUS_TIMEOUT_MS);
    if (showPending || state.service === null) {
      state.networkReady = null;
      state.service = null;
      state.serviceError = "";
      updateSystemLights();
    }
    const [networkResult, statusResult] = await Promise.allSettled([
      probeNetwork(controller.signal),
      requestJson("/api/status", { cache: "no-store", signal: controller.signal }),
    ]);
    window.clearTimeout(timeout);
    if (systemStatusController === controller) systemStatusController = null;
    if (epoch !== systemStatusEpoch) return;
    state.networkReady =
      (networkResult.status === "fulfilled" && networkResult.value === true) ||
      statusResult.status === "fulfilled";
    if (statusResult.status === "fulfilled") {
      state.service = statusResult.value;
      state.serviceError = "";
    } else {
      state.service = {
        storageReady: false,
        modelReady: false,
        qwenReady: false,
        modelPending: false,
        oaReady: false,
        knowledgeReady: false,
        retrievalReady: false,
        oaPending: false,
        budgetReady: false,
        systemReady: false,
      };
      state.serviceError = statusResult.reason instanceof Error
        ? statusResult.reason.message
        : "暂时无法连接服务，请稍后重试。";
    }
    systemStatusCheckedAt = Date.now();
    statusText.textContent = serviceLabel(state.service);
    updateSystemLights();
    syncFeedback();
    scheduleNextSystemStatusRefresh();
  }

  let viewportFrame = 0;
  function syncChatViewport() {
    window.cancelAnimationFrame(viewportFrame);
    viewportFrame = window.requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const followsVisualViewport = viewport && [questionInput, newChatInput].includes(document.activeElement);
      const height = followsVisualViewport ? viewport.height : window.innerHeight;
      const offsetTop = followsVisualViewport ? viewport.offsetTop : 0;
      app.style.setProperty("--chat-viewport-height", `${Math.max(1, Math.round(height))}px`);
      app.style.setProperty("--chat-viewport-offset", `${Math.max(0, Math.round(offsetTop))}px`);
      if (sessionFor().stickToEnd) messageScroll.scrollTop = messageScroll.scrollHeight;
    });
  }

  function openChatInfo() {
    if (chatInfoDialog.open) return;
    chatInfoDialogOpener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : chatInfoButton;
    questionInput.blur();
    syncChatViewport();
    chatInfoButton.setAttribute("aria-expanded", "true");
    chatInfoDialog.showModal();
    window.requestAnimationFrame(() => {
      syncChatViewport();
      chatInfoBack.focus({ preventScroll: true });
    });
  }

  function closeChatInfo({ restoreFocus = true } = {}) {
    if (!chatInfoDialog.open) return;
    if (!restoreFocus) chatInfoDialogOpener = null;
    chatInfoDialog.close();
  }

  function clearSearchMatches() {
    for (const match of messageScroll.querySelectorAll(".search-match")) {
      match.classList.remove("search-match");
      match.removeAttribute("aria-current");
      const originalLabel = match.getAttribute("data-search-original-label");
      if (originalLabel) match.setAttribute("aria-label", originalLabel);
      match.removeAttribute("data-search-original-label");
    }
  }

  function findChatMessage() {
    const rawQuery = window.prompt("查找聊天记录");
    if (rawQuery === null) return;
    const query = rawQuery.trim();
    if (!query) return;
    closeChatInfo({ restoreFocus: false });
    clearSearchMatches();

    const conversationId = state.activeConversationId;
    const session = conversationFor(conversationId);
    const normalizedQuery = query.toLocaleLowerCase();
    const matchIndex = session.messages.findIndex((message) => (
      String(message.content || "").toLocaleLowerCase().includes(normalizedQuery)
    ));
    if (matchIndex < 0) {
      window.alert("未找到相关聊天记录。");
      return;
    }

    window.requestAnimationFrame(() => {
      if (state.activeConversationId !== conversationId) return;
      const match = messageScroll.querySelectorAll(".message").item(matchIndex);
      if (!(match instanceof HTMLElement)) return;
      const originalLabel = match.getAttribute("aria-label") || "聊天消息";
      match.classList.add("search-match");
      match.setAttribute("aria-current", "true");
      match.setAttribute("data-search-original-label", originalLabel);
      match.setAttribute("aria-label", `聊天记录搜索结果：${originalLabel}`);
      match.scrollIntoView({ behavior: "smooth", block: "center" });
      match.focus({ preventScroll: true });
      topicStatus.textContent = `已找到包含“${query}”的聊天记录`;
    });
  }

  function searchRecentConversations() {
    const rawQuery = window.prompt("搜索最近聊天");
    if (rawQuery === null) return;
    const query = rawQuery.trim().toLocaleLowerCase();
    if (!query) return;
    const match = recentChatConversations(state.conversations).find((conversation) => (
      conversation.title.toLocaleLowerCase().includes(query) ||
      conversation.messages.some((message) => String(message.content || "").toLocaleLowerCase().includes(query))
    ));
    if (!match) {
      window.alert("未找到相关最近聊天。");
      return;
    }
    activateConversation(match.id, { historyMode: "push", announce: true });
    closeTopicDrawer();
  }

  function renderRecentConversations() {
    const recent = recentChatConversations(state.conversations);
    for (const list of recentLists) {
      list.replaceChildren();
      if (!recent.length) {
        list.append(element("p", { className: "sidebar-recent-empty", text: "暂无聊天记录" }));
        continue;
      }
      for (const conversation of recent) {
        const item = element("div", {
          className: "sidebar-recent-entry",
          attributes: { role: "listitem" },
        });
        const button = textButton("", "sidebar-recent-item");
        button.setAttribute("aria-label", `${conversation.title}，${topicFor(conversation.section).title}`);
        if (conversation.id === state.activeConversationId) {
          button.classList.add("selected");
          button.setAttribute("aria-current", "true");
        }
        button.append(element("span", {
          className: "sidebar-recent-title",
          text: conversation.title,
        }));
        button.addEventListener("click", () => {
          activateConversation(conversation.id, { historyMode: "push", announce: true });
          closeTopicDrawer();
        });
        item.append(button);
        list.append(item);
      }
    }
  }

  function createConversation(section) {
    const previousActiveId = state.activeConversationId;
    state.conversations = state.conversations.filter((item) => (
      item.id === previousActiveId || item.sending || item.messages.length || String(item.draft || "").trim()
    ));
    const conversation = blankConversation(section);
    state.conversations.push(conversation);
    const ranked = [...state.conversations]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const keep = new Set(ranked.slice(0, CHAT_CONVERSATION_LIMIT).map((item) => item.id));
    keep.add(conversation.id);
    if (previousActiveId) keep.add(previousActiveId);
    for (const item of state.conversations) {
      if (item.sending) keep.add(item.id);
    }
    state.conversations = state.conversations.filter((item) => keep.has(item.id));
    return conversation;
  }

  function activateConversation(conversationId, { historyMode = "none", announce = false } = {}) {
    const conversation = conversationFor(conversationId);
    if (!conversation) return false;
    const previousSection = state.section;
    const changed = state.activeConversationId !== conversation.id;
    if (changed) saveCurrentView();
    state.activeConversationId = conversation.id;
    state.section = conversation.section;
    if (previousSection !== state.section) trackPageView(state.section);
    const topic = topicFor(conversation.section);
    if (historyMode === "push" && (changed || window.location.pathname !== topic.path)) {
      window.history.pushState({ topic: topic.id, conversationId: conversation.id }, "", topic.path);
    }
    questionInput.value = conversation.draft;
    resizeQuestionInput();
    clearSearchMatches();
    syncFeedback();
    updateComposer();
    renderMessages({
      scrollMode: conversation.messages.length === 0
        ? "start"
        : conversation.stickToEnd ? "end" : "restore",
    });
    syncTopicControls();
    renderRecentConversations();
    persistSession();
    if (announce) topicStatus.textContent = `已打开${conversation.title}`;
    return true;
  }

  function startNewChatQuestion(rawQuestion, suggestionToken = "") {
    const question = String(rawQuestion || "").trim();
    if (!question) return false;
    analytics.track("new_chat", { section: newChatSection });
    const conversation = createConversation(newChatSection);
    closeNewChat();
    activateConversation(conversation.id, { historyMode: "push" });
    dispatchQuestion(question, conversation.id, suggestionToken);
    return true;
  }

  function resetCurrentConversation({ closeDrawer = false, closeInfo = false } = {}) {
    const session = sessionFor();
    if (session.sending || !hasResettableState(session)) return false;
    const removedId = session.id;
    const section = session.section;
    state.conversations = state.conversations.filter((conversation) => conversation.id !== removedId);
    const replacement = createConversation(section);
    state.activeConversationId = replacement.id;
    state.section = section;
    const replacementTopic = topicFor(section);
    window.history.replaceState?.(
      { ...(window.history.state || {}), topic: replacementTopic.id, conversationId: replacement.id },
      "",
      replacementTopic.path,
    );
    if (state.inquiry.conversationId === removedId) {
      state.inquiry.summary = "";
      state.inquiry.includeConversation = false;
      state.inquiry.conversationId = "";
    }
    questionInput.value = "";
    clearSearchMatches();
    resizeQuestionInput();
    syncFeedback();
    updateComposer();
    renderMessages({ scrollMode: "start" });
    syncTopicControls();
    renderRecentConversations();
    persistSession();
    topicStatus.textContent = "已删除当前聊天";
    if (closeDrawer) closeTopicDrawer();
    if (closeInfo) closeChatInfo();
    window.requestAnimationFrame(() => questionInput.focus());
    return true;
  }

  function resizeQuestionInput() {
    questionInput.style.height = "44px";
    questionInput.style.height = `${Math.min(questionInput.scrollHeight, 112)}px`;
  }

  function saveCurrentView() {
    const session = sessionFor();
    if (!session) return;
    if (session.draft !== questionInput.value) session.updatedAt = Date.now();
    session.draft = questionInput.value;
    session.scrollTop = messageScroll.scrollTop;
    session.stickToEnd = session.messages.length === 0 ||
      messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
    persistSession();
  }

  function syncTopicControls() {
    for (const [section, links] of topicLinks) {
      const selected = section === state.section;
      for (const link of links) {
        link.classList.toggle("selected", selected);
        if (selected) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      }
    }
    topicTitle.textContent = topicFor().title;
  }

  function activateTopic(section, { historyMode = "none", announce = false } = {}) {
    const nextTopic = CHAT_TOPICS.find((topic) => topic.id === section);
    if (!nextTopic) return;
    const active = conversationFor(state.activeConversationId);
    const reusable = active?.section === nextTopic.id && active.messages.length === 0 && !active.sending
      ? active
      : state.conversations
        .filter((conversation) => conversation.section === nextTopic.id &&
          conversation.messages.length === 0 && !conversation.sending)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const conversation = reusable || createConversation(nextTopic.id);
    activateConversation(conversation.id, { historyMode, announce: false });
    if (announce) topicStatus.textContent = `已切换到${nextTopic.title}`;
  }

  function syncFeedback() {
    const session = sessionFor();
    setRegion(errorRegion, session.error || state.serviceError);
    setRegion(noticeRegion, session.notice);
  }

  function updateComposer() {
    const session = sessionFor();
    sendButton.disabled = session.sending || !questionInput.value.trim();
    sendButton.textContent = session.sending ? "回答中" : "发送";
    questionInput.setAttribute("aria-busy", session.sending ? "true" : "false");
    for (const button of chatLaunchButtons) button.disabled = session.sending;
    clearChatHistory.disabled = session.sending || !hasResettableState(session);
    messageScroll.setAttribute("aria-busy", session.sending ? "true" : "false");
    for (const [section, links] of topicLinks) {
      const busy = state.conversations.some((conversation) => conversation.section === section && conversation.sending);
      for (const button of links) {
        button.classList.toggle("busy", busy);
        button.setAttribute("aria-busy", busy ? "true" : "false");
      }
    }
  }

  async function copyAnswer(content, conversationId, label = "回答") {
    const session = conversationFor(conversationId);
    if (!session) return;
    try {
      await writeMessageClipboard(content);
      session.notice = `已复制${label}`;
    } catch (error) {
      session.notice = error.message || "无法自动复制，请长按选择文字。";
    }
    if (state.activeConversationId === conversationId) syncFeedback();
  }

  function editChatQuestion(message, conversationId, opener) {
    const session = conversationFor(conversationId);
    if (!session || session.sending) return;
    openQuestionEditor(String(message.content || ""), opener, (question) => {
      const current = conversationFor(conversationId);
      const index = current?.messages.indexOf(message) ?? -1;
      if (!current || current.sending || index < 0 || state.activeConversationId !== conversationId) {
        throw new Error("当前聊天已变化，请关闭编辑窗口后重试。");
      }
      // Editing forks the prefix, never deletes the original thread and never reuses its signed token.
      const branch = createConversation(current.section);
      branch.messages = current.messages.slice(0, index).map((turn) => ({ ...turn }));
      branch.conversationToken = "";
      branch.tokenSavedAt = 0;
      branch.draft = question;
      activateConversation(branch.id, { historyMode: "push" });
      dispatchQuestion(question, branch.id);
    });
  }

  function assistantMessageNode(message, conversationId) {
    const article = element("article", {
      className: `message ${message.role}`,
      attributes: {
        "aria-label": message.role === "user" ? "你发送的消息" : `${APP_NAME} 的回答`,
        tabindex: "-1",
      },
    });
    const answer = message.role === "assistant"
      ? userFacingAnswer(message.content)
      : String(message.content || "");
    article.append(message.role === "assistant"
      ? renderAnswerBody(answer)
      : element("div", { className: "message-body", text: answer }));

    if (message.role === "assistant") {
      if (validatedKnowledgeImages(message.images).length) article.append(renderKnowledgeImages(message.images));
      const actions = element("div", { className: "message-actions", attributes: { role: "group", "aria-label": "回答操作" } });
      const share = (opener, intent) => {
        const session = conversationFor(conversationId);
        const index = session?.messages.indexOf(message) ?? -1;
        if (index < 0) return;
        const question = session.messages.slice(0, index).findLast((turn) => turn.role === "user")?.content || "";
        openAnswerShare({ v: 1, question: String(question), answer }, opener, intent);
      };
      const copy = messageActionButton("复制回答", "copy", "copy-answer", () => void copyAnswer(answer, conversationId));
      const copyLink = messageActionButton("复制链接", "link", "copy-answer-link", (event) => share(event.currentTarget, "copy"));
      const shareLink = messageActionButton("分享链接", "share", "share-answer", (event) => share(event.currentTarget, "share"));
      actions.append(copy, copyLink, shareLink);
      if (message.publicSources === true) {
        actions.append(element("span", { className: "message-source-note", text: "参考内部公开资料" }));
      }
      article.append(actions);
    } else if (message.role === "user") {
      installQuestionActions(article, answer,
        (opener) => editChatQuestion(message, conversationId, opener),
        () => copyAnswer(answer, conversationId, "提问"));
    }
    return article;
  }

  function dispatchQuestion(rawQuestion, conversationId = state.activeConversationId, suggestionToken = "") {
    const question = String(rawQuestion || "").trim();
    const session = conversationFor(conversationId);
    if (!question || !session || session.sending) return;
    const request = sendQuestion(question, conversationId, suggestionToken);
    if (state.activeConversationId === conversationId) questionInput.focus({ preventScroll: true });
    void request.catch(() => {});
  }

  function renderSuggestions() {
    const conversationId = state.activeConversationId;
    const session = conversationFor(conversationId);
    suggestionPanel.hidden = !recommendationsReady() || session.messages.length > 0 || session.sending || state.suggestions.length === 0;
    clearSuggestionList(suggestionList);
    suggestionList.setAttribute("aria-label", "根据近期入库知识生成的推荐话题");
    if (!suggestionPanel.hidden) {
      for (const suggestion of state.suggestions) {
        const button = textButton("", "suggestion-button");
        button.title = suggestion;
        button.append(
          element("span", {
            className: "suggestion-sparkle",
            text: "✦",
            attributes: { "aria-hidden": "true" },
          }),
          element("span", { text: suggestion }),
        );
        button.addEventListener("click", () => { void dispatchSuggestion(suggestion, conversationId); });
        suggestionList.append(button);
        observeSuggestionImpression(button, {
          surface: "composer",
          section: session.section,
          suggestion,
          conversationId,
        });
      }
    }
    renderNewChatSuggestions();
  }

  function renderNewChatSuggestions() {
    const ready = recommendationsReady() && !state.suggestionsLoading && state.suggestions.length > 0;
    newChatSuggestionPanel.hidden = !ready;
    clearSuggestionList(newChatSuggestionList);
    if (!ready) return;
    const dialogEpoch = newChatDialogEpoch;
    for (const suggestion of state.suggestions) {
      const button = textButton("", "new-chat-suggestion");
      button.append(
        element("span", {
          className: "suggestion-sparkle",
          text: "✦",
          attributes: { "aria-hidden": "true" },
        }),
        element("span", { text: suggestion }),
      );
      button.addEventListener("click", () => {
        void dispatchSuggestion(suggestion, "", {
          startNew: true,
          section: newChatSection,
          dialogEpoch,
        });
      });
      newChatSuggestionList.append(button);
    }
    if (newChatDialog.open) {
      window.requestAnimationFrame(() => { observeOpenNewChatSuggestions(dialogEpoch); });
    }
  }

  async function dispatchSuggestion(rawQuestion, conversationId, options = {}) {
    const question = String(rawQuestion || "").trim();
    const startNew = options.startNew === true;
    const target = startNew ? null : conversationFor(conversationId);
    const sourceDraft = startNew ? newChatInput.value : target?.draft;
    if (!question || !recommendationsReady() || state.suggestionsLoading || (!startNew && (!target || target.sending))) return;
    if (typeof analytics !== "undefined") {
      analytics.track("suggestion_click", {
        section: startNew ? options.section || newChatSection : target.section,
        suggestion: question,
      });
    }
    if (suggestionsRefreshTimer !== null) window.clearTimeout(suggestionsRefreshTimer);
    suggestionsRefreshTimer = null;
    suggestionsRefreshDueAt = 0;
    suggestionsRefreshPending = false;
    state.suggestions = [];
    state.suggestionsLoading = true;
    renderSuggestions();
    const epoch = ++suggestionsEpoch;
    let current = [];
    let suggestionToken = "";
    let refreshSucceeded = false;
    try {
      const payload = await requestJson("/api/suggestions", {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        timeoutMessage: "推荐话题核验超时。",
      });
      current = knowledgeSuggestionsFromPayload(payload);
      const candidate = payload.suggestions?.find((item) => item.question === question);
      suggestionToken = typeof candidate?.suggestionToken === "string" ? candidate.suggestionToken : "";
      refreshSucceeded = true;
    } catch {
      // A recommendation that cannot be revalidated is not sent to chat.
    } finally {
      if (epoch === suggestionsEpoch) {
        state.suggestions = current;
        state.suggestionsLoaded = true;
        state.suggestionsLoading = false;
        state.suggestionsFetchedAt = Date.now();
        renderSuggestions();
        if (knowledgeRetrievalReady()) {
          scheduleSuggestionsRefresh(refreshSucceeded ? suggestionsRefreshDelay() : SUGGESTIONS_RETRY_MS);
        }
      }
    }
    if (epoch !== suggestionsEpoch || !current.includes(question) || !recommendationsReady()) return;
    if (startNew) {
      if (!newChatDialog.open || options.dialogEpoch !== newChatDialogEpoch || options.section !== newChatSection ||
          newChatInput.value !== sourceDraft) return;
      startNewChatQuestion(question, suggestionToken);
      return;
    }
    const session = conversationFor(conversationId);
    if (state.activeConversationId === conversationId && session?.messages.length === 0 && !session.sending &&
        session.draft === sourceDraft) {
      dispatchQuestion(question, conversationId, suggestionToken);
    }
  }

  function scheduleSuggestionsRefresh(delay = suggestionsRefreshDelay()) {
    if (suggestionsRefreshTimer !== null) window.clearTimeout(suggestionsRefreshTimer);
    suggestionsRefreshDueAt = Date.now() + delay;
    suggestionsRefreshTimer = window.setTimeout(() => {
      suggestionsRefreshTimer = null;
      if (document.hidden) {
        suggestionsRefreshDueAt = Date.now();
        return;
      }
      suggestionsRefreshDueAt = 0;
      suggestionsRefreshPending = true;
      void loadSuggestions({ force: true });
    }, delay);
  }

  async function loadSuggestions({ force = false } = {}) {
    if (!recommendationsReady() || state.suggestionsLoading) {
      if (force && knowledgeRetrievalReady()) suggestionsRefreshPending = true;
      return;
    }
    if (state.suggestionsLoaded && !force) return;
    suggestionsRefreshPending = false;
    if (force) {
      state.suggestions = [];
      renderSuggestions();
    }
    state.suggestionsLoading = true;
    const epoch = ++suggestionsEpoch;
    let current = [];
    let refreshSucceeded = false;
    try {
      const payload = await requestJson("/api/suggestions", {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        timeoutMessage: "推荐话题加载超时。",
      });
      current = knowledgeSuggestionsFromPayload(payload);
      refreshSucceeded = true;
    } catch {
      // Recommendations are optional. Never replace verified knowledge with static guesses.
    } finally {
      if (epoch === suggestionsEpoch) {
        state.suggestions = current;
        state.suggestionsLoaded = true;
        state.suggestionsLoading = false;
        state.suggestionsFetchedAt = Date.now();
        renderSuggestions();
        if (knowledgeRetrievalReady()) {
          scheduleSuggestionsRefresh(refreshSucceeded ? suggestionsRefreshDelay() : SUGGESTIONS_RETRY_MS);
        }
      }
    }
  }

  function renderMessages({ scrollMode = "restore" } = {}) {
    const conversationId = state.activeConversationId;
    const session = conversationFor(conversationId);
    const topic = topicFor(session.section);
    const restoreTop = session.scrollTop;
    const epoch = ++renderEpoch;
    const content = element("div", { className: session.messages.length ? "message-list" : "empty-conversation" });
    conversation.classList.toggle("is-empty", session.messages.length === 0);
    if (session.messages.length) {
      for (const message of session.messages) content.append(assistantMessageNode(message, conversationId));
      if (session.sending) {
        content.append(
          element("div", {
            className: "thinking",
            attributes: { role: "status", "aria-live": "polite" },
          }, [
            icon("◌", "spin"),
            "正在检索并生成回答…",
          ]),
        );
      }
    } else {
      const capabilityGrid = element("div", { className: "empty-capability-grid" });
      for (const item of LAB_MODEL_CAPABILITIES) {
        const button = textButton("", "empty-capability-card");
        button.append(
          element("strong", { text: item.title }),
          element("span", { text: item.detail }),
        );
        button.addEventListener("click", () => useCapability(item.command));
        capabilityGrid.append(button);
      }
      content.append(element("section", {
        className: "empty-hero",
        attributes: { "aria-labelledby": "empty-chat-title" },
      }, [
        element("h2", {
          id: "empty-chat-title",
          text: "需要实验室大模型做什么？",
        }),
        element("p", {
          text: topic.id === GENERAL_CHAT_TOPIC.id
            ? "从已审核的实验室公开知识中检索并回答"
            : `从“${topic.title}”公开知识中检索并回答`,
        }),
        capabilityGrid,
      ]));
    }
    messageScroll.setAttribute("aria-live", "off");
    messageScroll.replaceChildren(content);
    messageScroll.setAttribute("role", session.messages.length ? "log" : "region");
    messageScroll.setAttribute("aria-label", `${topic.title}对话内容`);
    messageScroll.setAttribute("aria-live", session.messages.length ? "polite" : "off");
    renderSuggestions();
    window.requestAnimationFrame(() => {
      if (state.activeConversationId !== conversationId || renderEpoch !== epoch) return;
      if (session.messages.length === 0 || scrollMode === "start") {
        messageScroll.scrollTop = 0;
      } else if (scrollMode === "end") {
        messageScroll.scrollTop = messageScroll.scrollHeight;
      } else {
        const maximum = Math.max(0, messageScroll.scrollHeight - messageScroll.clientHeight);
        messageScroll.scrollTop = Math.min(restoreTop, maximum);
      }
      session.scrollTop = messageScroll.scrollTop;
      session.stickToEnd = session.messages.length === 0 ||
        messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
    });
  }

  async function sendQuestion(rawQuestion, conversationId = state.activeConversationId, suggestionToken = "") {
    const session = conversationFor(conversationId);
    if (!session) throw new Error("聊天记录不存在，请重新开始聊天");
    const topic = topicFor(session.section);
    const question = String(rawQuestion || "").trim();
    if (!question || session.sending) {
      if (session.sending) throw new Error("请等待当前回答完成");
      return null;
    }
    if (question.length > 2000) {
      session.error = "每次问题请控制在 2000 字以内。";
      if (state.activeConversationId === conversationId) syncFeedback();
      throw new Error(session.error);
    }
    const oaEvidenceEpoch = ++systemStatusEpoch;
    if (systemStatusController) {
      systemStatusController.abort();
      systemStatusController = null;
    }

    const previousMessages = session.messages.slice();
    const previousScrollTop = session.scrollTop;
    const previousStickToEnd = session.stickToEnd;
    let completed = false;
    session.sending = true;
    session.error = "";
    session.notice = "";
    session.messages.push({ role: "user", content: question });
    session.title = chatConversationTitle(session.messages);
    session.updatedAt = Date.now();
    session.draft = "";
    session.stickToEnd = true;
    persistSession();
    renderRecentConversations();
    if (state.activeConversationId === conversationId) {
      questionInput.value = "";
      resizeQuestionInput();
      syncFeedback();
      updateComposer();
      renderMessages({ scrollMode: "end" });
    }

    try {
      const payload = await requestJson("/api/chat", jsonOptions({
        messages: session.messages.filter((message) => message.role === "user").slice(-2).map(({ role, content }) => ({ role, content })),
        topic: topic.requestTopic,
        analyticsSection: session.section,
        ...(session.conversationToken ? { conversationToken: session.conversationToken } : {}),
        ...(suggestionToken ? { suggestionToken } : {}),
      }));
      reconcileChatOaStatus(payload, oaEvidenceEpoch);
      const assistant = {
        role: "assistant",
        content: userFacingAnswer(payload.answer),
        ...knowledgeImageFields({
          role: "assistant", images: payload.images,
          publicSources: payload.oaPublicStatus === "connected" && Array.isArray(payload.sources) && payload.sources.length > 0,
        }),
        mode: payload.mode,
        provider: payload.provider,
      };
      session.conversationToken = typeof payload.conversationToken === "string" ? payload.conversationToken : "";
      session.tokenSavedAt = Date.now();
      session.messages.push(assistant);
      session.updatedAt = Date.now();
      completed = true;
      return {
        answer: assistant.content,
      };
    } catch (error) {
      session.messages = previousMessages;
      session.draft = question;
      session.scrollTop = previousScrollTop;
      session.stickToEnd = previousStickToEnd;
      session.error = error instanceof Error ? error.message : "服务暂时不可用";
      if (state.activeConversationId === conversationId) {
        questionInput.value = session.draft;
        resizeQuestionInput();
        syncFeedback();
      }
      if (oaEvidenceEpoch === systemStatusEpoch) {
        systemStatusRetryDelay = SYSTEM_STATUS_RETRY_MS;
        scheduleNextSystemStatusRefresh();
      }
      throw error;
    } finally {
      session.sending = false;
      persistSession();
      renderRecentConversations();
      updateComposer();
      if (state.activeConversationId === conversationId) {
        questionInput.value = session.draft;
        resizeQuestionInput();
        syncFeedback();
        renderMessages({
          scrollMode: completed
            ? session.stickToEnd ? "end" : "restore"
            : session.messages.length === 0 ? "start" : session.stickToEnd ? "end" : "restore",
        });
      }
    }
  }

  function prefillInquirySummary() {
    const inquiry = state.inquiry;
    if (inquiry.conversationId !== state.activeConversationId) {
      inquiry.conversationId = state.activeConversationId;
      inquiry.section = state.section;
      inquiry.summary = "";
      inquiry.includeConversation = false;
    }
    if (inquiry.summary) return;
    inquiry.summary = conversationFor(inquiry.conversationId).messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n")
      .slice(0, 3000);
  }

  function renderInquiryDialog() {
    inquiryDialog.replaceChildren();
    const inquiry = state.inquiry;
    const headerBlock = element("div", { className: "dialog-header" });
    headerBlock.append(
      element("p", { className: "eyebrow", text: "CONTACT ARTS ROBOTICS" }),
      element("h2", {
        id: "inquiry-dialog-title",
        text: inquiry.reference ? "咨询已提交" : "向 ARTS Robotics 团队提交咨询",
      }),
      element("p", {
        id: "inquiry-dialog-description",
        className: "dialog-description",
        text: inquiry.reference
          ? "已进入待处理列表。提交不代表录取、报价或合作确认。"
          : "只有在你主动提交咨询后，联系信息及你选择附带的对话才会进入待处理列表。",
      }),
    );
    const close = textButton("关闭", "dialog-close");
    close.setAttribute("aria-label", "关闭咨询窗口");
    close.disabled = inquiry.submitting;
    close.addEventListener("click", () => inquiryDialog.close());
    headerBlock.append(close);
    inquiryDialog.append(headerBlock);

    if (inquiry.reference) {
      const success = element("div", { className: "ticket-success" });
      success.append(
        icon("✓", "success-icon"),
        element("strong", { text: `编号 ${inquiry.reference}` }),
        element("p", { text: "如需进一步沟通，团队将使用你提供的联系方式联系你。" }),
      );
      const done = textButton("完成", "primary-button");
      done.addEventListener("click", () => inquiryDialog.close());
      success.append(done);
      inquiryDialog.append(success);
      return;
    }

    const form = element("form", { className: "stack-form inquiry-form" });
    const pair = element("div", { className: "form-pair" });
    const nameField = createField("inquiry-name", "姓名");
    nameField.input.required = true;
    nameField.input.maxLength = 60;
    nameField.input.autocomplete = "name";
    nameField.input.value = inquiry.name;
    nameField.input.addEventListener("input", (event) => { inquiry.name = event.currentTarget.value; });
    const organisationField = createField("inquiry-organisation", "学校 / 单位");
    organisationField.input.maxLength = 120;
    organisationField.input.autocomplete = "organization";
    organisationField.input.value = inquiry.organisation;
    organisationField.input.addEventListener("input", (event) => { inquiry.organisation = event.currentTarget.value; });
    pair.append(nameField.wrapper, organisationField.wrapper);

    const contactField = createField("inquiry-contact", "邮箱、电话或微信");
    contactField.input.required = true;
    contactField.input.minLength = 3;
    contactField.input.maxLength = 120;
    contactField.input.autocomplete = "email";
    contactField.input.value = inquiry.contact;
    contactField.input.addEventListener("input", (event) => { inquiry.contact = event.currentTarget.value; });

    const summaryLabel = element("label", { attributes: { for: "inquiry-summary" } });
    summaryLabel.append(document.createTextNode("希望沟通的事项"));
    const summary = element("textarea", {
      id: "inquiry-summary",
      attributes: { required: true, minlength: "10", maxlength: "3000", rows: "4" },
    });
    summary.value = inquiry.summary;
    summary.addEventListener("input", (event) => { inquiry.summary = event.currentTarget.value; });
    summaryLabel.append(summary);

    const includeLabel = element("label", { className: "check-label" });
    const include = element("input", { attributes: { type: "checkbox" } });
    include.checked = inquiry.includeConversation;
    include.addEventListener("change", (event) => { inquiry.includeConversation = event.currentTarget.checked; });
    includeLabel.append(include, element("span", { text: "附上本次最近的对话，便于了解背景" }));

    const consentLabel = element("label", { className: "check-label" });
    const consent = element("input", { attributes: { type: "checkbox", required: true } });
    consent.checked = inquiry.consent;
    consent.addEventListener("change", (event) => { inquiry.consent = event.currentTarget.checked; });
    consentLabel.append(
      consent,
      element("span", {
        text: "同意将以上信息提交给 ARTS Robotics 团队及授权管理人员，用于本次咨询联络。",
      }),
    );

    const inquiryError = element("p", {
      className: "error",
      attributes: { role: "alert", "aria-live": "assertive" },
      text: inquiry.error,
    });
    inquiryError.hidden = !inquiry.error;
    const actions = element("div", { className: "dialog-actions" });
    const cancel = textButton("取消", "secondary-button");
    cancel.disabled = inquiry.submitting;
    cancel.addEventListener("click", () => inquiryDialog.close());
    const submit = textButton(inquiry.submitting ? "正在提交…" : "确认提交", "primary-button");
    submit.type = "submit";
    submit.disabled = inquiry.submitting || !inquiry.consent;
    consent.addEventListener("change", () => { submit.disabled = inquiry.submitting || !consent.checked; });
    actions.append(cancel, submit);
    form.append(pair, contactField.wrapper, summaryLabel, includeLabel, consentLabel, inquiryError, actions);
    form.addEventListener("submit", (event) => void submitInquiry(event));
    inquiryDialog.append(form);
  }

  async function submitInquiry(event) {
    event.preventDefault();
    const inquiry = state.inquiry;
    const session = conversationFor(inquiry.conversationId) || sessionFor();
    const topic = topicFor(session.section);
    if (inquiry.submitting || !inquiry.consent) return;
    inquiry.submitting = true;
    inquiry.error = "";
    renderInquiryDialog();
    try {
      const payload = await requestJson("/api/inquiries", jsonOptions({
        requestId: inquiry.requestId,
        name: inquiry.name,
        organisation: inquiry.organisation,
        contact: inquiry.contact,
        topic: topic.requestTopic,
        summary: inquiry.summary,
        consent: inquiry.consent,
        includeConversation: inquiry.includeConversation,
        transcript: inquiry.includeConversation
          ? session.messages.slice(-12).map(({ role, content }) => ({ role, content }))
          : [],
      }));
      inquiry.reference = String(payload.reference || "");
      inquiry.name = "";
      inquiry.organisation = "";
      inquiry.contact = "";
      inquiry.summary = "";
      inquiry.consent = false;
      inquiry.includeConversation = false;
      inquiry.section = "";
      inquiry.conversationId = "";
    } catch (error) {
      inquiry.error = error instanceof Error ? error.message : "提交失败";
    } finally {
      inquiry.submitting = false;
      renderInquiryDialog();
    }
  }

  function openInquiry(opener) {
    if (state.inquiry.submitting) return;
    inquiryDialogOpener = opener instanceof HTMLElement ? opener : document.activeElement;
    prefillInquirySummary();
    state.inquiry.requestId = makeRequestId();
    state.inquiry.reference = "";
    state.inquiry.error = "";
    renderInquiryDialog();
    if (!inquiryDialog.open) inquiryDialog.showModal();
    window.requestAnimationFrame(() => inquiryDialog.querySelector("input")?.focus());
  }

  function createField(id, labelText, type = "text") {
    const wrapper = element("label", { attributes: { for: id } });
    wrapper.append(document.createTextNode(labelText));
    const input = element("input", { id, attributes: { type } });
    wrapper.append(input);
    return { wrapper, input };
  }

  messageScroll.addEventListener("scroll", () => {
    const session = sessionFor();
    session.scrollTop = messageScroll.scrollTop;
    session.stickToEnd = session.messages.length === 0 ||
      messageScroll.scrollHeight - messageScroll.clientHeight - messageScroll.scrollTop <= 24;
    scheduleHistorySave();
  }, { passive: true });
  questionInput.addEventListener("input", () => {
    const session = sessionFor();
    session.draft = questionInput.value;
    session.updatedAt = Date.now();
    scheduleHistorySave();
    resizeQuestionInput();
    updateComposer();
  });
  questionInput.addEventListener("focus", syncChatViewport);
  questionInput.addEventListener("blur", syncChatViewport);
  window.addEventListener("resize", syncChatViewport, { passive: true });
  window.addEventListener("pagehide", analytics.flush, { passive: true });
  window.visualViewport?.addEventListener("resize", syncChatViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncChatViewport, { passive: true });
  questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dispatchQuestion(questionInput.value, state.activeConversationId);
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatchQuestion(questionInput.value, state.activeConversationId);
  });
  window.addEventListener("popstate", (event) => {
    const conversation = conversationFor(event.state?.conversationId);
    const section = topicIdForPath(window.location.pathname);
    if (conversation?.section === section) {
      activateConversation(conversation.id, { announce: true });
    } else {
      activateTopic(section, { announce: true });
    }
  });

  window.history.replaceState?.(
    { ...(window.history.state || {}), topic: state.section, conversationId: state.activeConversationId },
    "",
    window.location.href,
  );

  questionInput.value = sessionFor().draft;
  trackPageView(state.section);
  if (installedWebApp) trackInstallSuccessOnce();
  syncTopicControls();
  renderRecentConversations();
  syncFeedback();
  renderMessages({ scrollMode: sessionFor().stickToEnd ? "end" : "restore" });
  resizeQuestionInput();
  syncChatViewport();
  updateComposer();
  updateSystemLights();
  void loadSystemStatus({ showPending: true });
  window.addEventListener("online", () => {
    void loadSystemStatus({ showPending: true });
  });
  window.addEventListener("offline", () => {
    systemStatusEpoch += 1;
    systemStatusController?.abort();
    systemStatusController = null;
    state.networkReady = false;
    state.service = null;
    state.serviceError = "暂时无法连接服务，请稍后重试。";
    updateSystemLights();
    syncFeedback();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flushHistory(); return; }
    const now = Date.now();
    const statusRefreshDue =
      (systemStatusRefreshDueAt > 0 && now >= systemStatusRefreshDueAt) ||
      (systemStatusRefreshDueAt === 0 && now - systemStatusCheckedAt >= SYSTEM_STATUS_REFRESH_MS);
    const suggestionsRefreshDue =
      (suggestionsRefreshDueAt > 0 && now >= suggestionsRefreshDueAt) ||
      (suggestionsRefreshDueAt === 0 && beijingDayKey(now) !== beijingDayKey(state.suggestionsFetchedAt));
    if (statusRefreshDue) {
      void loadSystemStatus({ showPending: true });
    } else if (suggestionsRefreshDue) {
      void loadSuggestions({ force: true });
    }
  });

  window.addEventListener("pagehide", flushHistory);
  registerPublicServiceWorker();

  const modelContext = document.modelContext;
  if (modelContext && typeof modelContext.registerTool === "function") {
    const controller = new AbortController();
    const tool = {
      name: "ask_arts_robotics_assistant",
      title: `向 ${APP_NAME} 提问`,
      description: "提交问题并在当前对话中显示回答；不提交联系人或转交咨询。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["question"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: async (input) => {
        if (!input || typeof input.question !== "string" || !input.question.trim() || input.question.length > 2000) {
          throw new Error("请输入 1–2000 字的问题");
        }
        const conversationId = state.activeConversationId;
        if (conversationFor(conversationId)?.sending) throw new Error("请等待当前回答完成");
        return sendQuestion(input.question, conversationId);
      },
    };
    try {
      Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => {});
      window.addEventListener("pagehide", () => controller.abort(), { once: true });
    } catch {
      // Model Context support is optional in ordinary browsers.
    }
  }
}

function createAdminApp() {
  document.documentElement.classList.remove("public-chat-page");
  document.body.classList.remove("public-chat-page");

  const state = {
    signedIn: null,
    authChecked: false,
    authBusy: false,
    authError: "",
    loading: false,
    busy: "",
    error: "",
    notice: "",
    activeTab: "inquiries",
    initialized: false,
    oaStatus: null,
    config: {
      baseUrl: "",
      model: "qwen-plus",
      apiKey: "",
      keyConfigured: false,
      encryptionReady: false,
      activeProvider: null,
      workersAiReady: false,
    },
    documents: [],
    oaStatusSyncRequired: false,
    oaStatusSyncing: false,
    oaStatusSyncQueued: false,
    inquiries: [],
    analytics: null,
    analyticsDays: 7,
    analyticsLoadedDays: 0,
    analyticsLoading: false,
    analyticsError: "",
    importJob: null,
    failedImportFiles: [],
    draft: emptyDraft(),
    returnedKnowledgeItemId: returnedKnowledgeItemIdFromSearch(window.location.search),
  };
  let analyticsRequestEpoch = 0;

  function emptyDraft() {
    return {
      id: "",
      title: "",
      body: "",
      url: "",
      category: "research",
      updatedAt: new Date().toISOString().slice(0, 10),
      published: 0,
      draftRevision: null,
      oaSubmissionState: "unsubmitted",
      submissionRequestId: "",
      knowledgeAssets: [],
    };
  }

  function adminRequest(endpoint, options) {
    return requestJson(`/api/admin/${endpoint}`, options);
  }

  async function importedFileDigest(file) {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function extractImportFile(descriptor) {
    if (descriptor.isZip) {
      if (typeof window.unpackKnowledgeZip !== "function") {
        throw new Error("ZIP 解析组件未加载，请刷新页面后重试。");
      }
      const packageFiles = await window.unpackKnowledgeZip(descriptor.file);
      const indexFile = packageFiles.find((file) => String(file.name || "").toLowerCase() === "index.md");
      if (!indexFile) throw new Error("ZIP 必须包含根目录 index.md。");
      const text = decodeImportedUtf8(await indexFile.arrayBuffer());
      if (utf8ByteLength(text) > MAX_TEXT_IMPORT_BYTES) {
        throw new Error("ZIP 中 index.md 正文不能超过 5 MB（按 UTF-8 计算）。");
      }
      const assets = packageFiles
        .filter((file) => String(file.name || "").toLowerCase() !== "index.md")
        .map((file) => ({ path: String(file.name || ""), file }));
      return { text, assets };
    }
    if (descriptor.isText) {
      const text = decodeImportedUtf8(await descriptor.file.arrayBuffer());
      if (utf8ByteLength(text) > MAX_TEXT_IMPORT_BYTES) {
        throw new Error("规范化后的 TXT、Markdown 正文不能超过 5 MB（按 UTF-8 计算）。");
      }
      return { text, assets: [] };
    }
    const result = await adminRequest("extract", {
      method: "POST",
      headers: {
        "Content-Type": descriptor.mimeType,
        "X-File-Name": encodeURIComponent(descriptor.file.name),
      },
      body: descriptor.file,
      signal: AbortSignal.timeout(120_000),
      timeoutMessage: "文件处理超时，请压缩或拆分文件后重试。",
    });
    if (typeof result.text !== "string") throw new Error("文件解析结果异常，请稍后重试。");
    return { text: result.text, assets: [] };
  }

  async function uploadKnowledgeAssetsToOa(assetUpload, assets) {
    if (!assets.length) return;
    if (!assetUpload || !assetUpload.revisionId || !assetUpload.uploadToken) {
      throw new Error("OA 已接收正文，但未返回图片上传会话。请重试。");
    }
    const expectedPaths = assets.map((asset) => asset.path);
    for (const asset of assets) {
      const response = await fetch("https://oa.omindos.ai/api/knowledge/assets", {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": asset.file.type || "application/octet-stream",
          "X-Knowledge-Item-Id": assetUpload.itemId,
          "X-Knowledge-Revision-Id": assetUpload.revisionId,
          "X-Knowledge-Upload-Token": assetUpload.uploadToken,
          "X-Knowledge-Asset-Path": asset.path,
        },
        body: asset.file,
        signal: AbortSignal.timeout(120_000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `图片上传失败：${asset.path}`);
    }
    const finalizeResponse = await fetch("https://oa.omindos.ai/api/knowledge/assets/finalize", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: assetUpload.itemId,
        revisionId: assetUpload.revisionId,
        uploadToken: assetUpload.uploadToken,
        expectedPaths,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const finalizeResult = await finalizeResponse.json().catch(() => ({}));
    if (!finalizeResponse.ok) throw new Error(finalizeResult.error || "图片清单未能完成确认，请重试。");
  }

  async function importDocumentFiles(files, { source = "files", retry = false } = {}) {
    if (state.busy) return false;
    let descriptors;
    try {
      descriptors = prepareImportFiles(files);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "文件选择无效。";
      state.notice = "";
      renderAdminShell();
      return false;
    }
    if (!retry && state.draft.body.trim() && !window.confirm("批量导入将替换当前正文，是否继续？")) return false;

    state.busy = "files";
    state.error = "";
    state.notice = "";
    state.failedImportFiles = [];
    state.importJob = {
      total: descriptors.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      duplicates: 0,
      currentName: "准备导入…",
      failures: [],
      running: true,
    };
    renderAdminShell();

    const results = new Array(descriptors.length);
    const digestTasks = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < descriptors.length) {
        const index = cursor;
        cursor += 1;
        const descriptor = descriptors[index];
        state.importJob.currentName = descriptor.path;
        renderAdminShell();
        try {
          const digest = await importedFileDigest(descriptor.file);
          const prior = digestTasks.get(digest);
          if (prior) {
            await prior;
            state.importJob.duplicates += 1;
            results[index] = { descriptor, duplicate: true };
          } else {
            const task = extractImportFile(descriptor);
            digestTasks.set(digest, task);
            const extracted = await task;
            if (normalizeImportedText(extracted.text).trim().length < 10) {
              throw new Error("未识别到足够内容，请换一份清晰文件或手动填写正文。");
            }
            results[index] = { descriptor, text: extracted.text, assets: extracted.assets || [] };
            state.importJob.succeeded += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "读取失败";
          state.importJob.failed += 1;
          state.importJob.failures.push({ path: descriptor.path, message, file: descriptor.file });
        } finally {
          state.importJob.completed += 1;
          renderAdminShell();
        }
      }
    };

    try {
      await Promise.all(Array.from(
        { length: Math.min(BATCH_IMPORT_CONCURRENCY, descriptors.length) },
        () => worker(),
      ));
      const importedBody = combineImportedSections(results, descriptors.length > 1 || source === "folder");
      if (!importedBody) throw new Error("本批文件均未成功识别，请查看失败清单后重试。");
      const nextBody = retry && state.draft.body.trim()
        ? `${normalizeImportedText(state.draft.body).trim()}\n\n---\n\n${importedBody}`
        : importedBody;
      if (utf8ByteLength(nextBody) > MAX_TEXT_IMPORT_BYTES) {
        throw new Error("批量识别后的正文超过 5 MB，请减少本批文件数量后重试。");
      }
      state.draft.body = nextBody;
      const assetResults = results.filter((result) => result?.assets?.length);
      state.draft.knowledgeAssets = assetResults.length === 1 && descriptors.length === 1 ? assetResults[0].assets : [];
      if (assetResults.length && !state.draft.knowledgeAssets.length) {
        throw new Error("包含图片的 ZIP 知识包请单独导入并提交，避免多份资料图片路径冲突。");
      }
      if (!state.draft.title) state.draft.title = suggestedBatchTitle(descriptors);
      state.failedImportFiles = state.importJob.failures.map((failure) => failure.file);
      const successCopy = `成功 ${state.importJob.succeeded} 个`;
      const duplicateCopy = state.importJob.duplicates ? `，跳过重复文件 ${state.importJob.duplicates} 个` : "";
      const failureCopy = state.importJob.failed ? `，失败 ${state.importJob.failed} 个，可在下方重试` : "";
      state.notice = `批量导入完成：${successCopy}${duplicateCopy}${failureCopy}。已合并为一条 Markdown 正文，原文件未保存；请核对后提交 OA 待审。`;
      return true;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "批量导入失败。";
      state.failedImportFiles = state.importJob.failures.map((failure) => failure.file);
      return false;
    } finally {
      state.importJob.running = false;
      state.importJob.currentName = "";
      state.busy = "";
      renderAdminShell();
    }
  }

  function clearReturnedKnowledgeContext(expectedItemId) {
    if (state.returnedKnowledgeItemId !== expectedItemId) return;
    state.returnedKnowledgeItemId = "";
    try {
      window.history.replaceState(window.history.state, "", withoutReturnedKnowledgeItemQuery(window.location.href));
    } catch {
      // The OA update has already succeeded; URL cleanup must not turn it into a false failure.
    }
    void reconcileUnknownDocumentStatuses();
  }

  async function submitDocumentToOa(draft, { retainedAsChatDraft = true, submissionContext = null } = {}) {
    const returnedKnowledgeItemId = submissionContext?.returnedKnowledgeItemId || "";
    if (submissionContext && !SAFE_RETURNED_KNOWLEDGE_ITEM_ID.test(returnedKnowledgeItemId)) {
      throw new Error("退回资料上下文无效，请从 OA 待审核列表重新进入。");
    }
    const retryCopy = retainedAsChatDraft
      ? "Chat 草稿已保留"
      : "正文和导入编号仍保留在当前页面";
    if (retainedAsChatDraft) {
      if (!Number.isSafeInteger(draft.draftRevision) || draft.draftRevision < 1) {
        throw new Error("Chat 草稿版本无效，请刷新后重试。");
      }
      let checkpoint;
      try {
        checkpoint = await adminRequest("documents", jsonOptions({
          id: draft.id,
          draftRevision: draft.draftRevision,
          submissionState: "unknown",
        }, "PATCH"));
      } catch {
        throw new Error("Chat 暂时无法记录提交操作，尚未发送至 OA。请刷新后重试。");
      }
      const checkpointDocument = checkpoint?.document;
      if (!checkpointDocument
        || checkpointDocument.id !== draft.id
        || Number(checkpointDocument.draftRevision) !== draft.draftRevision
        || !["unknown", "submitted"].includes(checkpointDocument.oaSubmissionState)
        || (checkpointDocument.oaSubmissionState === "submitted"
          && !SAFE_RETURNED_KNOWLEDGE_ITEM_ID.test(String(checkpointDocument.oaItemId || "")))) {
        throw new Error("Chat 提交状态返回异常，尚未发送至 OA。请刷新后重试。");
      }
      state.documents = state.documents.map((document) => (
        document.id === draft.id ? { ...document, ...checkpointDocument } : document
      ));
      if (checkpointDocument.oaSubmissionState === "submitted") {
        state.notice = "该版本资料已提交 OA，重复操作不会新增条目。请打开 OA 查看当前审核状态。";
        return;
      }
    }
    let response;
    try {
      response = await fetch(OA_CHAT_IMPORT_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: {
            id: draft.id, title: draft.title, body: draft.body, url: draft.url || "",
            category: draft.category, updatedAt: draft.updatedAt,
          },
          ...(returnedKnowledgeItemId ? { returnedKnowledgeItemId } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      if (retainedAsChatDraft) {
        state.oaStatusSyncRequired = true;
        void reconcileUnknownDocumentStatuses();
      }
      throw new Error(`${retryCopy}，暂未确认进入 OA。请确认已登录 OA 后重试；重复提交不会重复建单。`);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (retainedAsChatDraft) {
        state.oaStatusSyncRequired = true;
        void reconcileUnknownDocumentStatuses();
      }
      throw new Error(result.error || `${retryCopy}，OA 暂未接收，请稍后重试。`);
    }
    const receipt = oaImportReceipt(result, draft.body);
    const item = receipt.items.length === 1 ? receipt.items[0] : null;
    const oaItemId = String(item?.id || "").toLowerCase();
    if (!item
      || !SAFE_RETURNED_KNOWLEDGE_ITEM_ID.test(oaItemId)
      || (returnedKnowledgeItemId && oaItemId !== returnedKnowledgeItemId.toLowerCase())) {
      if (retainedAsChatDraft) {
        state.oaStatusSyncRequired = true;
        void reconcileUnknownDocumentStatuses();
      }
      throw new Error(`OA 未返回有效接收记录，${retryCopy}，请刷新后重试。`);
    }
    const knowledgeAssets = Array.isArray(draft.knowledgeAssets) ? draft.knowledgeAssets : [];
    if (knowledgeAssets.length) {
      await uploadKnowledgeAssetsToOa({ ...(result.assetUpload || {}), itemId: oaItemId }, knowledgeAssets);
    }
    if (retainedAsChatDraft) {
      let persisted;
      try {
        persisted = await adminRequest("documents", jsonOptions({
          id: draft.id,
          draftRevision: draft.draftRevision,
          submissionState: "submitted",
          oaItemId,
        }, "PATCH"));
      } catch {
        state.oaStatusSyncRequired = true;
        void reconcileUnknownDocumentStatuses();
        throw new Error("OA 已接收，但 Chat 未能保存提交状态。请刷新后重试；重复提交不会新增条目。");
      }
      const persistedDocument = persisted?.document;
      if (!persistedDocument
        || persistedDocument.id !== draft.id
        || Number(persistedDocument.draftRevision) !== draft.draftRevision
        || persistedDocument.oaSubmissionState !== "submitted"
        || String(persistedDocument.oaItemId || "").toLowerCase() !== oaItemId) {
        state.oaStatusSyncRequired = true;
        void reconcileUnknownDocumentStatuses();
        throw new Error("OA 已接收，但 Chat 提交状态返回异常。请刷新后重试；重复提交不会新增条目。");
      }
      state.documents = state.documents.map((document) => (
        document.id === draft.id ? { ...document, ...persistedDocument } : document
      ));
    }
    if (returnedKnowledgeItemId) clearReturnedKnowledgeContext(returnedKnowledgeItemId);
    const isLargeDocument = draft.body.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS;
    state.notice = returnedKnowledgeItemId
      ? `已更新原 OA 条目并重新进入待审核状态（正文存为 ${receipt.partCount} 个片段）。Chat 未保留原文件或正文草稿。`
      : receipt.items.every((item) => item.status === "pending")
      ? isLargeDocument
        ? `已提交 OA，作为 1 条资料待审，并存为 ${receipt.partCount} 个片段（每个不超过 20000 字）${knowledgeAssets.length ? `，图片 ${knowledgeAssets.length} 张已上传` : ""}。Chat 未保留原文件或正文草稿。`
        : `已提交 OA 待审（${receipt.items.length} 条）${knowledgeAssets.length ? `，图片 ${knowledgeAssets.length} 张已上传` : ""}。在 OA“实验室 AI”的待审核列表中处理，对内或公开由审核时选择。`
      : "OA 已接收过该版本资料，重复提交不会新增条目。请打开 OA 查看当前审核状态。";
  }

  async function lookupDocumentSubmissionState(document) {
    const response = await fetch(OA_CHAT_IMPORT_STATUS_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document: {
          id: document.id,
          title: document.title,
          body: document.body,
          url: document.url || "",
          category: document.category,
          updatedAt: document.updatedAt,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "暂时无法核对 OA 提交状态。");
    if (result.documentId !== document.id || typeof result.submitted !== "boolean") {
      throw new Error("OA 提交状态返回异常。");
    }
    const oaItemId = result.submitted ? String(result.item?.id || "") : "";
    if (result.submitted && !SAFE_RETURNED_KNOWLEDGE_ITEM_ID.test(oaItemId)) {
      throw new Error("OA 提交状态返回异常。");
    }
    const persisted = await adminRequest("documents", jsonOptions({
      id: document.id,
      draftRevision: document.draftRevision,
      submissionState: result.submitted ? "submitted" : "unsubmitted",
      ...(result.submitted ? { oaItemId } : {}),
    }, "PATCH"));
    const persistedDocument = persisted?.document;
    const expectedState = result.submitted ? "submitted" : "unsubmitted";
    if (!persistedDocument
      || persistedDocument.id !== document.id
      || Number(persistedDocument.draftRevision) !== document.draftRevision
      || persistedDocument.oaSubmissionState !== expectedState
      || (result.submitted && String(persistedDocument.oaItemId || "").toLowerCase() !== oaItemId.toLowerCase())) {
      throw new Error("Chat 提交状态返回异常。");
    }
    state.documents = state.documents.map((candidate) => (
      candidate.id === document.id ? { ...candidate, ...persistedDocument } : candidate
    ));
  }

  async function reconcileUnknownDocumentStatuses() {
    const unknown = state.documents.filter((document) => document.oaSubmissionState === "unknown");
    if (!unknown.length) {
      state.oaStatusSyncRequired = false;
      return;
    }
    if (state.returnedKnowledgeItemId) return;
    if (state.oaStatusSyncing) {
      state.oaStatusSyncQueued = true;
      return;
    }
    state.oaStatusSyncing = true;
    state.oaStatusSyncQueued = false;
    let failed = false;
    try {
      for (let index = 0; index < unknown.length; index += 5) {
        const results = await Promise.allSettled(unknown.slice(index, index + 5).map(lookupDocumentSubmissionState));
        if (results.some((result) => result.status === "rejected")) failed = true;
        if (!state.loading) renderAdminShell();
      }
    } catch {
      failed = true;
    } finally {
      state.oaStatusSyncRequired = failed
        || state.documents.some((document) => document.oaSubmissionState === "unknown");
      const rerun = state.oaStatusSyncQueued;
      state.oaStatusSyncQueued = false;
      state.oaStatusSyncing = false;
      if (!state.loading) renderAdminShell();
      if (rerun && !state.returnedKnowledgeItemId) void reconcileUnknownDocumentStatuses();
    }
  }

  async function fetchAdminData(initial = false) {
    const [configPayload, documentPayload, inquiryPayload] = await Promise.all([
      adminRequest("config"),
      adminRequest("documents"),
      adminRequest("inquiries"),
    ]);
    state.config = {
      ...state.config,
      ...configPayload,
      apiKey: "",
    };
    state.documents = Array.isArray(documentPayload.documents) ? documentPayload.documents : [];
    if (!state.documents.some((document) => document.oaSubmissionState === "unknown")) {
      state.oaStatusSyncRequired = false;
    }
    void reconcileUnknownDocumentStatuses();
    state.inquiries = Array.isArray(inquiryPayload.inquiries) ? inquiryPayload.inquiries : [];
    if (initial && !state.initialized) {
      state.activeTab = state.returnedKnowledgeItemId ? "documents" : state.config.keyConfigured ? "inquiries" : "model";
      if (state.returnedKnowledgeItemId) {
        state.notice = "OA 大文档已退回。请重新上传修改后的完整文件；本次仅替换正文，标题、分类、资料日期、来源链接和可见范围沿用原 OA 条目。成功提交后会更新原条目并保留审计链；Chat 不保存原文件或正文。";
      }
      state.initialized = true;
    }
  }

  async function loadAnalytics(days = state.analyticsDays) {
    if (![1, 7, 30].includes(days)) return;
    const epoch = ++analyticsRequestEpoch;
    state.analyticsDays = days;
    state.analyticsLoading = true;
    state.analyticsError = "";
    renderAdminShell();
    try {
      const payload = await adminRequest(`analytics?days=${days}`);
      if (epoch !== analyticsRequestEpoch) return;
      state.analytics = payload;
      state.analyticsLoadedDays = days;
    } catch (error) {
      if (epoch !== analyticsRequestEpoch) return;
      state.analyticsError = error instanceof Error ? error.message : "读取统计数据失败";
    } finally {
      if (epoch === analyticsRequestEpoch) {
        state.analyticsLoading = false;
        renderAdminShell();
      }
    }
  }

  function ensureAnalyticsData() {
    if (state.analyticsLoading || (state.analytics && state.analyticsLoadedDays === state.analyticsDays)) return;
    void loadAnalytics(state.analyticsDays);
  }

  async function runAdminAction(key, action) {
    if (state.busy) return;
    state.busy = key;
    state.error = "";
    state.notice = "";
    renderAdminShell();
    try {
      await action();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "操作失败";
    } finally {
      state.busy = "";
      renderAdminShell();
    }
  }

  function renderLogin() {
    const shell = element("main", { className: "admin-shell auth-shell" });
    const back = element("a", {
      className: "primary-link back-link",
      text: "返回咨询页面",
      attributes: { href: "/" },
    });
    const card = element("section", { className: "admin-card auth-card" });
    card.append(
      element("p", { className: "eyebrow", text: "SECURE ACCESS" }),
      element("h1", { text: `${APP_NAME} · 管理` }),
    );
    if (state.returnedKnowledgeItemId) {
      card.append(element("p", { className: "admin-notice", text: "登录后请重新上传 OA 退回的大文档；退回条目编号会保留到提交成功。" }));
    }

    if (!state.authChecked && !state.authError) {
      card.append(
        element("p", {
          className: "thinking",
          attributes: { role: "status", "aria-live": "polite" },
        }, [icon("◌", "spin"), "正在连接…"]),
      );
    } else {
      const form = element("form", { className: "stack-form auth-form" });
      const passwordLabel = element("label", { attributes: { for: "admin-password" } });
      const password = element("input", {
        id: "admin-password",
        attributes: {
          type: "password",
          required: true,
          maxlength: "256",
          autocomplete: "current-password",
        },
      });
      passwordLabel.append(document.createTextNode("管理员密码"), password);
      const submit = textButton(state.authBusy ? "正在登录…" : "登录", "primary-button");
      submit.type = "submit";
      submit.disabled = state.authBusy;
      form.append(passwordLabel, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.authBusy) return;
        state.authBusy = true;
        state.authError = "";
        submit.disabled = true;
        submit.textContent = "正在登录…";
        try {
          await requestJson("/api/auth/login", jsonOptions({ password: password.value }));
          password.value = "";
          state.signedIn = true;
          state.loading = true;
          renderAdminShell();
          try {
            await fetchAdminData(true);
          } catch (error) {
            state.error = error instanceof Error ? error.message : "读取管理数据失败";
          } finally {
            state.loading = false;
            renderAdminShell();
          }
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "登录失败";
          state.authBusy = false;
          renderLogin();
        }
      });
      card.append(form);
    }

    const authError = element("p", {
      className: "error",
      text: state.authError,
      attributes: { role: "alert", "aria-live": "assertive" },
    });
    authError.hidden = !state.authError;
    card.append(authError);
    shell.append(back, card);
    root.replaceChildren(shell);
  }

  function adminHeader() {
    const header = element("header", { className: "topbar admin-topbar" });
    const returnLink = element("a", {
      className: "site-link",
      attributes: { href: "/" },
    }, [icon("←"), "返回咨询页面"]);
    const actions = element("div", { className: "admin-header-actions" });
    const logout = textButton(state.busy === "logout" ? "正在退出…" : "退出管理", "secondary-button");
    logout.disabled = Boolean(state.busy);
    logout.addEventListener("click", () => {
      void runAdminAction("logout", async () => {
        await requestJson("/api/auth/logout", jsonOptions({}));
        state.signedIn = false;
        state.authChecked = true;
        state.authBusy = false;
        state.authError = "";
        state.initialized = false;
        renderLogin();
      });
    });
    actions.append(returnLink, logout);
    header.append(brandLink(), actions);
    return header;
  }

  function tabButton(id, label, count) {
    const selected = state.activeTab === id;
    const button = textButton("", `admin-tab${selected ? " selected" : ""}`);
    button.id = `admin-tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.setAttribute("aria-controls", `admin-panel-${id}`);
    button.tabIndex = selected ? 0 : -1;
    button.append(element("span", { text: label }));
    if (count !== undefined) button.append(element("span", { className: "tab-count", text: count }));
    button.addEventListener("click", () => {
      state.activeTab = id;
      renderAdminShell();
      document.getElementById(`admin-tab-${id}`)?.focus();
      if (id === "analytics") ensureAnalyticsData();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const ids = ["analytics", "inquiries", "documents", "model"];
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = (ids.indexOf(id) + offset + ids.length) % ids.length;
      state.activeTab = ids[next];
      renderAdminShell();
      document.getElementById(`admin-tab-${ids[next]}`)?.focus();
      if (state.activeTab === "analytics") ensureAnalyticsData();
    });
    return button;
  }

  function adminPanel(id, className = "admin-card") {
    return element("section", {
      id: `admin-panel-${id}`,
      className,
      attributes: {
        role: "tabpanel",
        "aria-labelledby": `admin-tab-${id}`,
        tabindex: "0",
      },
    });
  }

  function labelledInput(id, labelText, type = "text") {
    const label = element("label", { attributes: { for: id } });
    label.append(document.createTextNode(labelText));
    const input = element("input", { id, attributes: { type } });
    label.append(input);
    return { label, input };
  }

  function renderModelPanel() {
    const panel = adminPanel("model");
    panel.append(
      element("p", { className: "eyebrow", text: "MODEL CONNECTION" }),
      element("h2", { text: "阿里云百炼 · 通义千问" }),
      element("p", { className: "admin-notice", text: state.config.activeProvider === "bailian"
        ? `当前使用阿里云千问 · ${state.config.model} · 已保存并验证`
        : state.config.workersAiReady ? "当前使用 Cloudflare 备用模型；阿里云配置验证通过后自动切换。"
        : "当前为资料检索模式；保存并连接千问后启用 AI 回答。" }),
      element("p", {
        className: "admin-notice",
        text: "选择华北 2（北京）地域。密钥仅在此管理页填写，保存后不会再显示完整值。模型调用按阿里云账户实际用量计费。",
      }),
    );

    const form = element("form", { className: "stack-form model-form" });
    const baseUrl = labelledInput("model-base-url", "API Base URL", "url");
    baseUrl.input.required = true;
    baseUrl.input.maxLength = 300;
    baseUrl.input.placeholder = "https://业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    baseUrl.input.value = state.config.baseUrl || "";
    baseUrl.input.addEventListener("input", (event) => { state.config.baseUrl = event.currentTarget.value; });
    baseUrl.label.append(
      element("span", {
        className: "small-note",
        text: "在百炼“业务空间管理”复制 API Host，再加 /compatible-mode/v1。",
      }),
    );

    const model = labelledInput("model-name", "模型名称");
    model.input.required = true;
    model.input.maxLength = 101;
    model.input.pattern = "qwen[a-zA-Z0-9_.-]{1,100}";
    model.input.value = state.config.model || "qwen-plus";
    model.input.addEventListener("input", (event) => { state.config.model = event.currentTarget.value; });
    model.label.append(
      element("span", {
        className: "small-note",
        text: "默认 qwen-plus，以你的北京地域控制台可用模型为准。",
      }),
    );

    const apiKey = labelledInput("model-api-key", "API Key", "password");
    apiKey.input.maxLength = 400;
    apiKey.input.autocomplete = "new-password";
    apiKey.input.spellcheck = false;
    apiKey.input.className = "secret-input";
    apiKey.input.placeholder = state.config.keyConfigured ? "已保存；不更换则留空" : "在此填写百炼 API Key";
    apiKey.input.value = state.config.apiKey || "";
    apiKey.input.addEventListener("input", (event) => { state.config.apiKey = event.currentTarget.value; });

    const actions = element("div", { className: "admin-buttons" });
    const save = textButton(state.busy === "config" ? "正在验证并保存…" : "保存并连接", "primary-button");
    save.type = "submit";
    save.disabled = Boolean(state.busy) || !state.config.encryptionReady;
    const test = textButton(state.busy === "model-test" ? "正在检测…" : "检测连接", "secondary-button");
    test.disabled = Boolean(state.busy) || !state.config.keyConfigured;
    test.addEventListener("click", () => {
      void runAdminAction("model-test", async () => {
        await adminRequest("test", jsonOptions({}));
        state.config = { ...state.config, ...await adminRequest("config"), apiKey: "" };
        state.notice = "连接成功，真实 AI 对话已可使用。";
      });
    });
    actions.append(save, test);
    form.append(baseUrl.label, model.label, apiKey.label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runAdminAction("config", async () => {
        const body = {
          baseUrl: state.config.baseUrl,
          model: state.config.model,
        };
        if (state.config.apiKey) body.apiKey = state.config.apiKey;
        const result = await adminRequest("config", jsonOptions(body));
        state.config = { ...state.config, ...result };
        state.config.apiKey = "";
        state.config.keyConfigured = true;
        state.notice = "千问连接已验证，配置已保存并启用。之后的提问会继续使用该配置。";
      });
    });
    panel.append(form);
    const consoleLink = externalLink("打开阿里云百炼控制台", BAILIAN_CONSOLE, "primary-link");
    if (consoleLink) panel.append(consoleLink);
    if (!state.config.encryptionReady) {
      panel.append(element("p", { className: "error", text: "安全保存尚未配置，请先完成站点的加密设置。" }));
    }
    panel.append(
      element("p", {
        className: "small-note",
        text: "当前版本默认每个访问来源每小时最多 25 次提问，全站每日最多 300 次 AI 回答。未接入生成模型时仍可使用公开资料检索模式。",
      }),
    );
    return panel;
  }

  function renderDocumentsPanel() {
    const wrapper = element("div", {
      id: "admin-panel-documents",
      className: "admin-panel-stack",
      attributes: {
        role: "tabpanel",
        "aria-labelledby": "admin-tab-documents",
        tabindex: "0",
      },
    });

    const connection = element("section", { className: "admin-card" });
    const oaStatus = state.oaStatus === "connected"
      ? "已连接"
      : state.oaStatus === "not_configured"
        ? "未配置"
        : ["auth_error", "rate_limited", "timeout", "invalid_response", "unavailable"].includes(state.oaStatus)
          ? "暂不可用"
          : "尚未检测";
    connection.append(
      element("p", { className: "eyebrow", text: "KNOWLEDGE CONNECTION" }),
      element("h2", { text: "OA 公开知识连接" }),
      element("p", {
        className: "small-note",
        text: `只检测服务端连接和响应格式，不显示也不返回 Token。状态：${oaStatus}`,
      }),
    );
    const probe = textButton(state.busy === "oa-test" ? "正在检测…" : "检测 OA 公开知识", "secondary-button");
    probe.disabled = Boolean(state.busy);
    probe.addEventListener("click", () => {
      void runAdminAction("oa-test", async () => {
        const payload = await adminRequest("oa-test", jsonOptions({}));
        state.oaStatus = payload.oaPublicKnowledge || "unavailable";
        state.notice = state.oaStatus === "connected"
          ? "OA 公开知识连接正常。"
          : state.oaStatus === "not_configured"
            ? "尚未配置 OA 公共知识服务 Token。"
            : state.oaStatus === "auth_error"
              ? "OA 服务凭证校验失败，请检查两端 Token。"
              : state.oaStatus === "rate_limited"
                ? "OA 检索请求较多，请稍后再检测。"
                : state.oaStatus === "timeout"
                  ? "OA 检索检测超时，系统会自动重试；无需重复填写 Token。"
                  : state.oaStatus === "invalid_response"
                    ? "OA 返回格式异常，系统会自动重试。"
                    : "OA 公开知识暂时不可用，系统会自动重试。";
      });
    });
    connection.append(element("div", { className: "admin-buttons" }, [probe]));

    const editor = element("section", { className: "admin-card document-editor" });
    editor.append(
      element("p", { className: "eyebrow", text: "DRAFT WORKSPACE" }),
      element("h2", {
        text: state.returnedKnowledgeItemId
          ? "重提 OA 退回资料"
          : state.draft.id ? "编辑资料" : "添加待审核草稿",
      }),
      element("p", {
        className: "small-note",
        text: state.returnedKnowledgeItemId
          ? "请重新上传修改后的完整文件。Chat 不保存原文件或正文；OA 接收成功后会更新原条目并新增修订记录。"
          : "保存后提交至 OA 待审。请在同一浏览器登录 OA；审核时选择对内或公开，未经审核的资料不会用于回答。",
      }),
    );
    const form = element("form", { className: "stack-form document-form" });
    const title = labelledInput("document-title", "资料标题");
    title.input.required = true;
    title.input.minLength = 2;
    title.input.maxLength = 120;
    title.input.value = state.draft.title;
    title.input.disabled = Boolean(state.busy);
    title.input.addEventListener("input", (event) => { state.draft.title = event.currentTarget.value; });

    const pair = element("div", { className: "form-pair" });
    const categoryLabel = element("label", { attributes: { for: "document-category" } });
    categoryLabel.append(document.createTextNode("咨询方向"));
    const category = element("select", { id: "document-category" });
    category.disabled = Boolean(state.busy);
    for (const id of ["student", "research", "business"]) {
      const option = element("option", { text: TOPIC_LABELS[id], attributes: { value: id } });
      if (state.draft.category === id) option.selected = true;
      category.append(option);
    }
    category.addEventListener("change", (event) => { state.draft.category = event.currentTarget.value; });
    categoryLabel.append(category);
    const date = labelledInput("document-date", "资料日期", "date");
    date.input.required = true;
    date.input.value = state.draft.updatedAt;
    date.input.disabled = Boolean(state.busy);
    date.input.addEventListener("input", (event) => { state.draft.updatedAt = event.currentTarget.value; });
    pair.append(categoryLabel, date.label);

    const url = labelledInput("document-url", "原始资料链接（可选）", "url");
    url.input.maxLength = 1500;
    url.input.value = state.draft.url;
    url.input.disabled = Boolean(state.busy);
    url.input.addEventListener("input", (event) => { state.draft.url = event.currentTarget.value; });

    const bodyLabel = element("label", { attributes: { for: "document-body" } });
    bodyLabel.append(document.createTextNode("供助手引用的正文"));
    const body = element("textarea", {
      id: "document-body",
      className: "admin-textarea",
      attributes: { required: true, minlength: "10" },
    });
    body.value = state.draft.body;
    body.disabled = Boolean(state.busy);
    body.addEventListener("input", (event) => { state.draft.body = event.currentTarget.value; });
    bodyLabel.append(body);

    const fileLabel = element("label", { attributes: { for: "document-file" } });
    fileLabel.append(document.createTextNode(state.busy === "files" ? "正在批量解析…" : "选择文件（支持多选）"));
    const fileInput = element("input", {
      id: "document-file",
      attributes: {
        type: "file",
        multiple: true,
        accept: ".md,.zip,.txt,.pdf,.jpg,.jpeg,.png,.webp,text/markdown,application/zip,application/x-zip-compressed,text/plain,application/pdf,image/jpeg,image/png,image/webp",
      },
    });
    const folderLabel = element("label", { attributes: { for: "document-folder" } });
    folderLabel.append(document.createTextNode("选择整个文件夹"));
    const folderInput = element("input", {
      id: "document-folder",
      attributes: {
        type: "file",
        multiple: true,
        directory: true,
        webkitdirectory: true,
        accept: ".txt,.md,.pdf,.jpg,.jpeg,.png,.webp,text/plain,text/markdown,application/pdf,image/jpeg,image/png,image/webp",
      },
    });
    const focusImportedField = (id) => {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(id);
        target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        target?.focus?.({ preventScroll: true });
      });
    };
    fileInput.disabled = Boolean(state.busy);
    folderInput.disabled = Boolean(state.busy);
    const handleImportSelection = (source) => (event) => {
      const selected = Array.from(event.currentTarget.files || []);
      if (!selected.length || state.busy) return;
      void importDocumentFiles(selected, { source }).then((imported) => {
        focusImportedField(imported ? "document-body" : source === "folder" ? "document-folder" : "document-file");
      });
    };
    fileInput.addEventListener("change", handleImportSelection("files"));
    folderInput.addEventListener("change", handleImportSelection("folder"));
    fileLabel.append(fileInput);
    folderLabel.append(folderInput);

    const importControls = element("div", { className: "document-import-controls" }, [fileLabel, folderLabel]);
    const importStatus = element("div", {
      className: "import-status",
      attributes: { "aria-live": "polite" },
    });
    if (state.importJob) {
      const progress = element("progress", {
        className: "import-progress",
        attributes: {
          max: String(state.importJob.total),
          value: String(state.importJob.completed),
          "aria-label": "批量导入进度",
        },
      });
      const statusText = state.importJob.running
        ? `正在处理 ${state.importJob.completed}/${state.importJob.total}：${state.importJob.currentName}`
        : `本批共 ${state.importJob.total} 个：成功 ${state.importJob.succeeded} 个，重复 ${state.importJob.duplicates} 个，失败 ${state.importJob.failed} 个。`;
      importStatus.append(progress, element("p", { className: "import-summary", text: statusText }));
      if (state.importJob.failures.length) {
        const failures = element("details", { className: "import-failure-list" });
        failures.append(element("summary", { text: `查看失败文件（${state.importJob.failures.length}）` }));
        const listItems = state.importJob.failures.map((failure) => element("li", {
          text: `${failure.path}：${failure.message}`,
        }));
        failures.append(element("ul", {}, listItems));
        importStatus.append(failures);
      }
      if (!state.importJob.running && state.failedImportFiles.length) {
        const retry = textButton(`重试失败项（${state.failedImportFiles.length}）`, "secondary-button small-button");
        retry.disabled = Boolean(state.busy);
        retry.addEventListener("click", () => {
          void importDocumentFiles(state.failedImportFiles, { source: "retry", retry: true });
        });
        importStatus.append(retry);
      }
    }
    const importHelp = element("p", {
      className: "small-note",
      text: "可一次选择多个文件或整个文件夹，每批最多 100 个、总计 500 MB。TXT、Markdown 单个文件最多 5 MB；PDF、扫描件和图片单个文件最多 10 MB，会以最多 3 个并行任务发送至 Cloudflare AI 临时解析。系统按路径排序、自动跳过重复内容，并合并为一条 Markdown 正文；本站不保存原件。解析正文不设 30000 字上限；大型正文会直接提交 OA，OA 作为 1 条资料统一审核，并自动拆成每个不超过 20000 字的存储片段。识别可能有误，请提交前核对。",
    });

    const actions = element("div", { className: "admin-buttons" });
    const directOaImport = Boolean(state.returnedKnowledgeItemId) || state.draft.body.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS;
    const save = textButton(
      state.busy === "document"
        ? directOaImport ? "正在直接提交…" : "正在保存并提交…"
        : directOaImport ? "直接提交 OA 待审" : "保存并提交 OA 待审",
      "primary-button",
    );
    save.type = "submit";
    save.disabled = Boolean(state.busy);
    actions.append(save);
    if (state.draft.id && !state.returnedKnowledgeItemId) {
      const cancel = textButton("取消编辑", "secondary-button");
      cancel.disabled = Boolean(state.busy);
      cancel.addEventListener("click", () => {
        state.draft = emptyDraft();
        state.importJob = null;
        state.failedImportFiles = [];
        renderAdminShell();
      });
      actions.append(cancel);
    }
    form.append(
      title.label,
      pair,
      url.label,
      bodyLabel,
      importControls,
      importStatus,
      importHelp,
      element("p", {
        className: "small-note",
        text: state.returnedKnowledgeItemId
          ? "退回大文档会直接更新原 OA 条目：本次仅替换正文，标题、分类、资料日期、来源链接和可见范围沿用原 OA 条目；Chat 不保存正文草稿，失败时在当前页面保留正文和条目编号，OA 接收成功后才清空。"
          : directOaImport
            ? "大型正文不在 Chat 保存草稿：提交失败时会在当前页面保留正文和导入编号，OA 接收成功后才清空。"
          : "提交失败时保留 Chat 草稿，可从下方列表重试；重复提交同一版本不会重复建单。",
      }),
      actions,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runAdminAction("document", async () => {
        const normalizedBody = normalizeImportedText(state.draft.body);
        if (utf8ByteLength(normalizedBody) > MAX_TEXT_IMPORT_BYTES) {
          throw new Error("正文不能超过 5 MB（按 UTF-8 计算）。");
        }
        if (normalizedBody.trim().length < 10) throw new Error("正文至少需要 10 个字符。");
        state.draft.body = normalizedBody;
        const returnedKnowledgeItemId = state.returnedKnowledgeItemId;
        if (!returnedKnowledgeItemId && state.draft.id && normalizedBody.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS) {
          throw new Error("已有 Chat 草稿不能直接改为大型正文。请取消编辑后，将大文档作为新资料直接提交 OA。");
        }
        if (returnedKnowledgeItemId || normalizedBody.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS) {
          const id = state.draft.id || state.draft.submissionRequestId || makeRequestId();
          state.draft.submissionRequestId = id;
          await submitDocumentToOa({ ...state.draft, id }, {
            retainedAsChatDraft: false,
            ...(returnedKnowledgeItemId ? { submissionContext: { returnedKnowledgeItemId } } : {}),
          });
          state.draft = emptyDraft();
          state.importJob = null;
          state.failedImportFiles = [];
          return;
        }
        const draft = { ...state.draft };
        const saved = await adminRequest("documents", jsonOptions({
          ...(state.draft.id ? { id: state.draft.id } : {}),
          ...(state.draft.id ? { draftRevision: state.draft.draftRevision } : {}),
          title: state.draft.title,
          body: normalizedBody,
          url: state.draft.url,
          category: state.draft.category,
          updatedAt: state.draft.updatedAt,
          published: 0,
        }));
        const payload = await adminRequest("documents");
        state.documents = Array.isArray(payload.documents) ? payload.documents : [];
        state.draft = emptyDraft();
        const savedDocument = state.documents.find((document) => document.id === saved.id);
        if (!savedDocument) throw new Error("资料已保存，但暂时无法读取，请刷新后重试。");
        await submitDocumentToOa({ ...draft, ...savedDocument });
        state.importJob = null;
        state.failedImportFiles = [];
      });
    });
    editor.append(form);

    const list = element("section", { className: "admin-card document-list" });
    list.append(
      element("p", { className: "eyebrow", text: "LOCAL DRAFTS" }),
      element("h2", { text: `资料列表 · ${state.documents.length}` }),
      externalLink("打开 OA 登录／查看待审核", OA_KNOWLEDGE_URL, "primary-link"),
    );
    if (state.oaStatusSyncRequired) {
      list.append(element("p", {
        className: "admin-notice",
        text: "部分历史资料尚未核对。请先在同一浏览器登录 OA，再刷新本页；核对不会提交资料。",
      }));
    }
    if (state.returnedKnowledgeItemId) {
      list.append(element("div", {
        className: "admin-empty",
        text: "当前正在重提 OA 退回资料。为避免把本地旧草稿误写入原条目，本地草稿已暂时隐藏，不能编辑或提交；本次重提完成后会自动恢复。",
      }));
    } else if (!state.documents.length) {
      list.append(element("div", { className: "admin-empty", text: "暂时没有待审核草稿。" }));
    } else {
      for (const document of state.documents) {
        const article = element("article", { className: "admin-item" });
        const head = element("div", { className: "admin-item-head" });
        const submissionState = document.oaSubmissionState === "submitted"
          ? "submitted"
          : document.oaSubmissionState === "unsubmitted"
            ? "unsubmitted"
            : "unknown";
        const submissionLabel = submissionState === "submitted"
          ? "OA 待审核"
          : submissionState === "unsubmitted"
            ? "待提交 OA 审核"
            : "待核对 OA 状态";
        head.append(
          element("div", {}, [
            element("h3", { text: String(document.title || "未命名资料") }),
            element("p", {
              text: `${TOPIC_LABELS[document.category] || "未分类"} · ${String(document.updatedAt || "未标注")} · ${submissionLabel}`,
            }),
          ]),
        );
        if (submissionState === "unsubmitted") {
          const edit = textButton("编辑", "secondary-button small-button");
          edit.disabled = Boolean(state.busy);
          edit.addEventListener("click", () => {
            state.draft = {
              id: String(document.id || ""),
              title: String(document.title || ""),
              body: String(document.body || ""),
              url: String(document.url || ""),
              category: TOPIC_LABELS[document.category] ? document.category : "research",
              updatedAt: String(document.updatedAt || emptyDraft().updatedAt),
              published: 0,
              draftRevision: Number(document.draftRevision),
              oaSubmissionState: "unsubmitted",
              submissionRequestId: "",
            };
            state.importJob = null;
            state.failedImportFiles = [];
            renderAdminShell();
            window.scrollTo({ top: 0, behavior: "smooth" });
          });
          head.append(edit);
          const submit = textButton(state.busy === `submit-${document.id}` ? "正在提交…" : "提交 OA 待审", "primary-button small-button");
          submit.disabled = Boolean(state.busy);
          submit.addEventListener("click", () => { void runAdminAction(`submit-${document.id}`, () => submitDocumentToOa(document)); });
          head.append(submit);
        } else {
          head.append(externalLink(
            submissionState === "submitted" ? "查看 OA" : "登录 OA 核对",
            OA_KNOWLEDGE_URL,
            "secondary-button small-button",
          ));
        }
        const documentBody = String(document.body || "");
        article.append(
          head,
          element("p", { text: `${documentBody.slice(0, 200)}${documentBody.length > 200 ? "…" : ""}` }),
        );
        list.append(article);
      }
    }

    wrapper.append(connection, editor, list);
    return wrapper;
  }

  function parseTranscript(value) {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((turn) => turn && typeof turn.content === "string" && (turn.role === "user" || turn.role === "assistant"));
  }

  function formatBeijingTime(value) {
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "未标注");
      return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    } catch {
      return String(value || "未标注");
    }
  }

  function renderInquiriesPanel() {
    const panel = adminPanel("inquiries");
    panel.append(
      element("p", { className: "eyebrow", text: "INQUIRIES" }),
      element("h2", { text: "咨询记录" }),
      element("p", {
        className: "small-note",
        text: "仅显示访客确认提交的内容。以下记录不表示已经发出通知或邮件。",
      }),
    );
    if (!state.inquiries.length) {
      panel.append(element("div", { className: "admin-empty", text: "暂时没有咨询。访客提交后会显示在这里。" }));
      return panel;
    }

    for (const inquiry of state.inquiries) {
      const article = element("article", { className: "admin-item inquiry-item" });
      const head = element("div", { className: "admin-item-head" });
      head.append(
        element("div", {}, [
          element("h3", {
            text: `${String(inquiry.name || "未署名")}${inquiry.organisation ? ` · ${inquiry.organisation}` : ""}`,
          }),
          element("p", {
            text: `${String(inquiry.reference || "无编号")} · ${TOPIC_LABELS[inquiry.topic] || "未分类"} · ${formatBeijingTime(inquiry.createdAt)}`,
          }),
        ]),
        element("span", { className: `status-label status-${inquiry.status}`, text: STATUS_LABELS[inquiry.status] || "未知" }),
      );
      article.append(
        head,
        element("p", { className: "contact-line", text: `联系方式：${String(inquiry.contact || "未提供")}` }),
        element("pre", { text: String(inquiry.summary || "") }),
      );
      const transcript = parseTranscript(inquiry.transcript);
      if (transcript.length) {
        const details = element("details", { className: "transcript-details" });
        details.append(
          element("summary", { className: "small-note", text: "查看访客同意附带的对话" }),
          element("pre", {
            text: transcript
              .map((turn) => `${turn.role === "user" ? "访客" : "助手"}：${turn.content}`)
              .join("\n\n"),
          }),
        );
        article.append(details);
      }
      const actions = element("div", { className: "admin-buttons" });
      for (const nextStatus of ["pending", "replied", "closed"]) {
        if (nextStatus === inquiry.status) continue;
        const action = textButton(`标记${STATUS_LABELS[nextStatus]}`, "secondary-button small-button");
        action.disabled = Boolean(state.busy);
        action.addEventListener("click", () => {
          void runAdminAction(`inquiry-${inquiry.id}`, async () => {
            await adminRequest("inquiries", jsonOptions({ id: inquiry.id, status: nextStatus }, "PATCH"));
            state.inquiries = state.inquiries.map((candidate) => (
              candidate.id === inquiry.id ? { ...candidate, status: nextStatus } : candidate
            ));
            state.notice = "状态已更新。";
          });
        });
        actions.append(action);
      }
      article.append(actions);
      panel.append(article);
    }
    return panel;
  }

  function analyticsCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.round(number).toLocaleString("zh-CN")
      : "0";
  }

  function analyticsRateValue(value) {
    const number = Number(value);
    return `${(Number.isFinite(number) && number >= 0 ? number : 0).toFixed(1)}%`;
  }

  function analyticsSectionLabel(section) {
    return CHAT_TOPICS.find((topic) => topic.id === section)?.title || String(section || "未分类");
  }

  function analyticsMetricCard(label, value, meta) {
    return element("article", { className: "analytics-kpi-card" }, [
      element("p", { className: "analytics-kpi-label", text: label }),
      element("p", { className: "analytics-kpi-value", text: value }),
      element("p", { className: "analytics-kpi-meta", text: meta }),
    ]);
  }

  function analyticsTable(label, headers, rows) {
    if (!rows.length) return element("div", { className: "admin-empty", text: "当前周期暂无数据。" });
    const table = element("table", { className: "analytics-table" });
    const head = element("thead");
    const headRow = element("tr");
    for (const header of headers) {
      headRow.append(element("th", { text: header, attributes: { scope: "col" } }));
    }
    head.append(headRow);
    const body = element("tbody");
    for (const row of rows) {
      const rowNode = element("tr");
      for (const value of row) rowNode.append(element("td", { text: value }));
      body.append(rowNode);
    }
    table.append(head, body);
    return element("div", {
      className: "analytics-table-wrap",
      attributes: { role: "region", "aria-label": label, tabindex: "0" },
    }, [table]);
  }

  function renderAnalyticsPanel() {
    const panel = adminPanel("analytics", "admin-card analytics-panel");
    const header = element("div", { className: "analytics-panel-header" });
    header.append(element("div", { className: "analytics-panel-copy" }, [
      element("p", { className: "eyebrow", text: "ANALYTICS" }),
      element("h2", { text: "数据统计" }),
      element("p", { text: "匿名汇总网站使用趋势；点击率按所选时段的点击次数除以曝光次数计算，不记录访客问题、回答或个人信息。数据可能受设备、浏览器、网络及异常流量影响。" }),
    ]));
    const range = element("div", {
      className: "analytics-range",
      attributes: { role: "group", "aria-label": "统计周期" },
    });
    for (const [days, label] of [[1, "今天"], [7, "近 7 天"], [30, "近 30 天"]]) {
      const button = textButton(label, "analytics-range-button");
      button.setAttribute("aria-pressed", state.analyticsDays === days ? "true" : "false");
      button.disabled = state.analyticsLoading && state.analyticsDays === days;
      button.addEventListener("click", () => {
        if (state.analyticsDays === days && state.analyticsLoadedDays === days && state.analytics) return;
        void loadAnalytics(days);
      });
      range.append(button);
    }
    header.append(range);
    panel.append(header);

    if (state.analyticsLoading && (!state.analytics || state.analyticsLoadedDays !== state.analyticsDays)) {
      panel.append(element("p", {
        className: "thinking analytics-loading",
        attributes: { role: "status", "aria-live": "polite" },
      }, [icon("◌", "spin"), "正在读取统计数据…"]));
      return panel;
    }
    if (state.analyticsError) {
      const retry = textButton("重新加载", "secondary-button");
      retry.addEventListener("click", () => { void loadAnalytics(state.analyticsDays); });
      panel.append(
        element("p", { className: "error", text: state.analyticsError, attributes: { role: "alert" } }),
        retry,
      );
      return panel;
    }

    const data = state.analytics;
    if (!data) {
      panel.append(element("div", { className: "admin-empty", text: "选择周期后查看统计数据。" }));
      return panel;
    }
    const totals = data.totals || {};
    const rates = data.rates || {};
    const period = data.period || {};
    const periodLabel = period.from && period.to
      ? `${period.from} 至 ${period.to} · 北京时间`
      : `${state.analyticsDays === 1 ? "今天" : `近 ${state.analyticsDays} 天`} · 北京时间`;
    const kpis = element("div", { className: "analytics-kpi-grid" });
    kpis.append(
      analyticsMetricCard("页面浏览", analyticsCount(totals.pageViews), periodLabel),
      analyticsMetricCard("提问次数", analyticsCount(totals.chatSubmits), `成功回答 ${analyticsCount(totals.chatSuccesses)} 次`),
      analyticsMetricCard(
        "推荐点击率",
        analyticsRateValue(rates.suggestionCtr),
        `${analyticsCount(totals.suggestionClicks)} 次点击 / ${analyticsCount(totals.suggestionImpressions)} 次曝光`,
      ),
      analyticsMetricCard(
        "响应成功率",
        analyticsRateValue(rates.chatSuccessRate),
        `${analyticsCount(totals.chatSuccesses)} 次成功 / ${analyticsCount(totals.chatSubmits)} 次提问`,
      ),
      analyticsMetricCard("安装成功", analyticsCount(totals.installs), `新建聊天 ${analyticsCount(totals.newChats)} 次`),
    );
    panel.append(kpis);

    const details = element("div", { className: "analytics-detail-grid" });
    const dailyCard = element("section", { className: "analytics-detail-card analytics-daily-card" });
    dailyCard.append(
      element("h3", { text: "逐日趋势" }),
      analyticsTable("逐日统计", ["日期", "浏览", "新聊天", "提问", "成功", "推荐曝光", "推荐点击", "点击率", "安装"],
        (Array.isArray(data.series) ? data.series : []).map((day) => [
          String(day.day || ""),
          analyticsCount(day.pageViews),
          analyticsCount(day.newChats),
          analyticsCount(day.chatSubmits),
          analyticsCount(day.chatSuccesses),
          analyticsCount(day.suggestionImpressions),
          analyticsCount(day.suggestionClicks),
          analyticsRateValue(day.suggestionImpressions
            ? Number(day.suggestionClicks || 0) / Number(day.suggestionImpressions) * 100
            : 0),
          analyticsCount(day.installs),
        ])),
    );

    const sectionCard = element("section", { className: "analytics-detail-card" });
    sectionCard.append(
      element("h3", { text: "主题表现" }),
      analyticsTable("主题表现", ["主题", "浏览", "提问", "推荐曝光", "推荐点击", "点击率"],
        (Array.isArray(data.sections) ? data.sections : []).map((item) => [
          analyticsSectionLabel(item.section),
          analyticsCount(item.pageViews),
          analyticsCount(item.chatSubmits),
          analyticsCount(item.suggestionImpressions),
          analyticsCount(item.suggestionClicks),
          analyticsRateValue(item.suggestionImpressions
            ? Number(item.suggestionClicks || 0) / Number(item.suggestionImpressions) * 100
            : 0),
        ])),
    );
    details.append(dailyCard, sectionCard);
    panel.append(details);

    const suggestionCard = element("section", { className: "analytics-detail-card analytics-suggestion-card" });
    suggestionCard.append(
      element("h3", { text: "热门推荐" }),
      analyticsTable("热门推荐", ["推荐问题", "曝光", "点击", "点击率"],
        (Array.isArray(data.topSuggestions) ? data.topSuggestions : []).map((item) => [
          String(item.suggestion || ""),
          analyticsCount(item.impressions),
          analyticsCount(item.clicks),
          analyticsRateValue(item.ctr),
        ])),
    );
    panel.append(suggestionCard);
    return panel;
  }

  function renderAdminShell() {
    if (!state.signedIn) {
      renderLogin();
      return;
    }
    const app = element("div", { className: "admin-app" });
    app.append(adminHeader());
    const shell = element("main", { className: "admin-shell" });
    const heading = element("div", { className: "admin-heading" });
    heading.append(
      element("div", {}, [
        element("p", { className: "eyebrow", text: "OPERATIONS CONSOLE" }),
        element("h1", { text: `${APP_NAME} · 管理` }),
        element("p", { text: "查看网站统计与 OA 连接，维护待审核草稿，处理咨询与模型配置。" }),
      ]),
    );
    const refreshingAnalytics = state.activeTab === "analytics" && state.analyticsLoading;
    const refresh = textButton(
      state.busy === "refresh" || refreshingAnalytics ? "正在刷新…" : "刷新",
      "secondary-button refresh-button",
    );
    refresh.disabled = Boolean(state.busy) || state.loading || refreshingAnalytics;
    refresh.addEventListener("click", () => {
      if (state.activeTab === "analytics") {
        void loadAnalytics(state.analyticsDays);
        return;
      }
      void runAdminAction("refresh", async () => {
        await fetchAdminData(false);
        state.notice = "管理数据已刷新。";
      });
    });
    heading.append(refresh);
    shell.append(heading);

    const error = element("p", {
      className: "error",
      text: state.error,
      attributes: { role: "alert", "aria-live": "assertive" },
    });
    error.hidden = !state.error;
    const notice = element("p", {
      className: "admin-notice global-notice",
      text: state.notice,
      attributes: { role: "status", "aria-live": "polite" },
    });
    notice.hidden = !state.notice;
    shell.append(error, notice);

    if (state.loading) {
      shell.append(
        element("p", {
          className: "thinking admin-loading",
          attributes: { role: "status", "aria-live": "polite" },
        }, [icon("◌", "spin"), "正在读取配置和咨询…"]),
      );
    } else {
      const tabs = element("div", {
        className: "admin-tabs",
        attributes: { role: "tablist", "aria-label": "管理功能" },
      });
      const pendingCount = state.inquiries.filter((inquiry) => inquiry.status === "pending").length;
      tabs.append(
        tabButton("analytics", "数据统计"),
        tabButton("inquiries", "咨询", pendingCount),
        tabButton("documents", "知识资料"),
        tabButton("model", "模型接入"),
      );
      shell.append(tabs);
      if (state.activeTab === "analytics") shell.append(renderAnalyticsPanel());
      if (state.activeTab === "model") shell.append(renderModelPanel());
      if (state.activeTab === "documents") shell.append(renderDocumentsPanel());
      if (state.activeTab === "inquiries") shell.append(renderInquiriesPanel());
    }
    app.append(shell);
    root.replaceChildren(app);
  }

  async function initialize() {
    renderLogin();
    try {
      const payload = await requestJson("/api/auth/status");
      state.signedIn = Boolean(payload.signedIn);
      state.authChecked = true;
      state.authError = "";
      if (state.signedIn) {
        state.loading = true;
        renderAdminShell();
        try {
          await fetchAdminData(true);
        } catch (error) {
          state.error = error instanceof Error ? error.message : "读取管理数据失败";
        } finally {
          state.loading = false;
          renderAdminShell();
        }
      } else {
        renderLogin();
      }
    } catch (error) {
      state.authChecked = true;
      state.authError = error instanceof Error ? error.message : "暂时无法连接，请刷新页面。";
      renderLogin();
    }
  }

  void initialize();
}

if (window.location.pathname === "/manage") {
  createAdminApp();
} else {
  createPublicApp();
}

void openIncomingSharedAnswer();
