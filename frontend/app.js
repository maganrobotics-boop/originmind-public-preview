"use strict";

const KATEX_ASSET = "__KATEX_ASSET__";
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

function addMessage(role, text, { html = false, typing = false } = {}) {
  const item = document.createElement("article");
  item.className = `message ${role}${typing ? " typing-message" : ""}`;
  if (typing) item.innerHTML = '<div class="assistant-mark"><i class="mini-loader"></i></div><div class="message-content"><div class="typing"><i></i><i></i><i></i></div></div>';
  else if (role === "assistant") item.innerHTML = `<div class="assistant-mark"><i class="mini-loader"></i></div><div class="message-content"><div class="answer-content"></div>${messageActions()}</div>`;
  else item.innerHTML = '<div class="message-content"><p></p></div>';
  if (!typing) {
    if (role === "assistant") item.querySelector(".answer-content").innerHTML = html ? text : renderMarkdown(text);
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
    addMessage("assistant", data.answer || "暂时没有生成回答。");
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
