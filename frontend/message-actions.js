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
