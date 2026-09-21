import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function harness() {
  const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const requests = [];
  const sent = [];
  const started = [];
  const timers = new Map();
  let nextTimer = 0;
  const api = runInNewContext(`
    const SUGGESTIONS_RETRY_MS = 5 * 60_000;
    const suggestionsRefreshDelay = () => 24 * 60 * 60_000;
    const state = {
      section: "academic", activeConversationId: "conversation-academic", networkReady: true,
      service: { knowledgeReady: true, retrievalReady: true },
      conversations: [
        { id: "conversation-academic", section: "academic", messages: [], sending: false },
        { id: "conversation-company", section: "company", messages: [], sending: false },
      ],
      suggestions: [], suggestionsLoaded: false, suggestionsLoading: false,
      suggestionsFetchedAt: 0,
    };
    const conversationFor = (conversationId) => (
      state.conversations.find((conversation) => conversation.id === conversationId) || null
    );
    const newChatDialog = { open: false };
    const newChatInput = { value: "" };
    let newChatSection = state.section;
    let newChatDialogEpoch = 0;
    const startNewChatQuestion = (question, suggestionToken) => {
      started.push({ question, suggestionToken, section: newChatSection });
    };
    let systemStatusController = null;
    let suggestionsRefreshTimer = null;
    let suggestionsRefreshDueAt = 0;
    let suggestionsRefreshPending = false;
    let suggestionsEpoch = 0;
    ${section("function cleanPublicChatText", "const TOPIC_LABELS")}
    ${section("function knowledgeRetrievalReady", "function setSystemLight")}
    ${section("async function dispatchSuggestion", "function renderMessages")}
    ({ state, loadSuggestions, dispatchSuggestion, invalidateSuggestions,
       probe: (active) => { systemStatusController = active ? {} : null; },
       openNewChat: (section = state.section) => {
         newChatSection = section;
         newChatDialogEpoch += 1;
         newChatDialog.open = true;
         return { section: newChatSection, dialogEpoch: newChatDialogEpoch };
       },
       closeNewChat: () => {
         newChatDialog.open = false;
         newChatDialogEpoch += 1;
       },
       setNewChatDraft: (value) => { newChatInput.value = value; } });
  `, {
    AbortSignal,
    started,
    document: { hidden: false },
    window: {
      setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: (id) => timers.delete(id),
    },
    renderSuggestions() {},
    requestJson: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    dispatchQuestion: (question, conversationId, suggestionToken) => sent.push({ question, conversationId, suggestionToken }),
  });
  const respond = (index, question) => requests[index].resolve({
    suggestions: [{ id: "1", question, updatedAt: "2026-09-14", suggestionToken: "fresh-source-token" }],
    oaPublicStatus: "connected",
  });
  return { ...api, requests, sent, started, timers, respond };
}

test("a late pre-disconnect response cannot overwrite the recovered suggestions", async () => {
  const h = await harness();
  const old = h.loadSuggestions();
  h.state.networkReady = false;
  h.invalidateSuggestions();
  h.state.networkReady = true;
  const fresh = h.loadSuggestions();
  h.respond(1, "恢复连接后的新话题");
  await fresh;
  h.respond(0, "断网前的旧话题");
  await old;
  assert.deepEqual([...h.state.suggestions], ["恢复连接后的新话题"]);
  assert.equal(h.state.suggestionsLoading, false);
  assert.equal(h.timers.size, 1);
});

test("a clicked suggestion is not sent after invalidation even if it revalidates late", async () => {
  const h = await harness();
  const click = h.dispatchSuggestion("已下架的话题", "conversation-academic");
  h.state.networkReady = false;
  h.invalidateSuggestions();
  h.respond(0, "已下架的话题");
  await click;
  assert.deepEqual(h.sent, []);
  assert.deepEqual([...h.state.suggestions], []);
  assert.equal(h.state.suggestionsLoading, false);
  assert.equal(h.timers.size, 0);
});

test("click revalidation sends once only while readiness and the source question remain valid", async () => {
  for (const scenario of ["ready", "probing", "removed", "switched"]) {
    const h = await harness();
    const click = h.dispatchSuggestion("当前知识话题", "conversation-academic");
    if (scenario === "probing") h.probe(true);
    if (scenario === "switched") h.state.activeConversationId = "conversation-company";
    h.respond(0, scenario === "removed" ? "另一条话题" : "当前知识话题");
    await click;
    assert.equal(h.sent.length, scenario === "ready" ? 1 : 0, scenario);
    if (scenario === "ready") {
      assert.deepEqual(h.sent[0], {
        question: "当前知识话题",
        conversationId: "conversation-academic",
        suggestionToken: "fresh-source-token",
      });
    }
    assert.equal(h.state.suggestionsLoading, false, scenario);
  }
});

test("typing during suggestion revalidation preserves the user's draft", async () => {
  const main = await harness();
  const mainClick = main.dispatchSuggestion("当前知识话题", "conversation-academic");
  main.state.conversations[0].draft = "我正在输入另一个问题";
  main.respond(0, "当前知识话题");
  await mainClick;
  assert.deepEqual(main.sent, []);
  assert.equal(main.state.conversations[0].draft, "我正在输入另一个问题");

  const modal = await harness();
  const dialog = modal.openNewChat("academic");
  const modalClick = modal.dispatchSuggestion("弹框中的知识话题", "", {
    startNew: true,
    section: dialog.section,
    dialogEpoch: dialog.dialogEpoch,
  });
  modal.setNewChatDraft("我正在弹框里输入");
  modal.respond(0, "弹框中的知识话题");
  await modalClick;
  assert.deepEqual(modal.started, []);
});

test("a new-chat suggestion cannot start a conversation after its dialog epoch becomes stale", async () => {
  for (const scenario of ["closed", "reopened"]) {
    const h = await harness();
    const dialog = h.openNewChat("academic");
    const click = h.dispatchSuggestion("弹框中的知识话题", "", {
      startNew: true,
      section: dialog.section,
      dialogEpoch: dialog.dialogEpoch,
    });
    h.closeNewChat();
    if (scenario === "reopened") h.openNewChat("academic");
    h.respond(0, "弹框中的知识话题");
    await click;
    assert.deepEqual(h.started, [], scenario);
    assert.deepEqual(h.sent, [], scenario);
    assert.equal(h.state.suggestionsLoading, false, scenario);
  }
});
