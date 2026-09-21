import { isNaturalSuggestionQuestion } from "./natural-suggestions.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

export const ANALYTICS_SECTIONS = Object.freeze([
  "general",
  "technology",
  "academic",
  "company",
  "association",
]);

export const ANALYTICS_EVENTS = Object.freeze([
  "page_view",
  "chat_submit",
  "chat_success",
  "suggestion_impression",
  "suggestion_click",
  "new_chat",
  "install_success",
]);

export const PUBLIC_ANALYTICS_EVENTS = Object.freeze([
  "page_view",
  "suggestion_impression",
  "suggestion_click",
  "new_chat",
  "install_success",
]);

const TOTAL_KEY_BY_EVENT = Object.freeze({
  page_view: "pageViews",
  chat_submit: "chatSubmits",
  chat_success: "chatSuccesses",
  suggestion_impression: "suggestionImpressions",
  suggestion_click: "suggestionClicks",
  new_chat: "newChats",
  install_success: "installs",
});

function emptyCounts() {
  return {
    pageViews: 0,
    chatSubmits: 0,
    chatSuccesses: 0,
    suggestionImpressions: 0,
    suggestionClicks: 0,
    newChats: 0,
    installs: 0,
  };
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

function timestampValue(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new RangeError("INVALID_ANALYTICS_DATE");
  return value;
}

export function beijingDayKey(now = Date.now()) {
  return new Date(timestampValue(now) + BEIJING_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function moveDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export function isNaturalSuggestion(value) {
  return isNaturalSuggestionQuestion(value);
}

function analyticsDimension(event) {
  if (event.type === "suggestion_impression" || event.type === "suggestion_click") {
    if (!isNaturalSuggestion(event.suggestion)) throw new TypeError("INVALID_ANALYTICS_SUGGESTION");
    return event.suggestion;
  }
  if (event.type === "chat_submit" || event.type === "chat_success") {
    if (!['typed', 'suggestion'].includes(event.source)) throw new TypeError("INVALID_ANALYTICS_SOURCE");
    return event.source;
  }
  return "";
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("INVALID_ANALYTICS_EVENT");
  }
  if (!ANALYTICS_EVENTS.includes(event.type) || !ANALYTICS_SECTIONS.includes(event.section)) {
    throw new TypeError("INVALID_ANALYTICS_EVENT");
  }
  return {
    type: event.type,
    section: event.section,
    dimension: analyticsDimension(event),
  };
}

export async function recordAnalyticsEvents(database, events, now = Date.now()) {
  if (!database?.prepare || !Array.isArray(events) || events.length < 1 || events.length > 5) {
    throw new TypeError("INVALID_ANALYTICS_WRITE");
  }
  const day = beijingDayKey(now);
  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    await database.prepare(`
      INSERT INTO analytics_daily (day,event,section,dimension,count)
      VALUES (?,?,?,?,1)
      ON CONFLICT(day,event,section,dimension)
      DO UPDATE SET count=count+1
    `).bind(day, event.type, event.section, event.dimension).run();
  }
}

export async function analyticsReport(database, days, now = Date.now()) {
  if (!database?.prepare || ![1, 7, 30].includes(days)) throw new TypeError("INVALID_ANALYTICS_RANGE");
  const to = beijingDayKey(now);
  const from = moveDay(to, 1 - days);
  const result = await database.prepare(`
    SELECT day,event,section,dimension,count
    FROM analytics_daily
    WHERE day>=? AND day<=?
    ORDER BY day,event,section,dimension
  `).bind(from, to).all();

  const totals = emptyCounts();
  const seriesByDay = new Map();
  for (let offset = 1 - days; offset <= 0; offset += 1) {
    const day = moveDay(to, offset);
    seriesByDay.set(day, { day, ...emptyCounts() });
  }
  const sectionsById = new Map(ANALYTICS_SECTIONS.map((section) => [section, {
    section,
    pageViews: 0,
    chatSubmits: 0,
    suggestionImpressions: 0,
    suggestionClicks: 0,
  }]));
  const suggestionsByQuestion = new Map();

  for (const row of result.results || []) {
    const totalKey = TOTAL_KEY_BY_EVENT[row.event];
    const count = safeCount(row.count);
    if (!totalKey || !seriesByDay.has(row.day) || !sectionsById.has(row.section)) continue;
    totals[totalKey] += count;
    seriesByDay.get(row.day)[totalKey] += count;

    const section = sectionsById.get(row.section);
    if (row.event === "page_view") section.pageViews += count;
    if (row.event === "chat_submit") section.chatSubmits += count;
    if (row.event === "suggestion_impression") section.suggestionImpressions += count;
    if (row.event === "suggestion_click") section.suggestionClicks += count;

    if ((row.event === "suggestion_impression" || row.event === "suggestion_click")
      && isNaturalSuggestion(row.dimension)) {
      const suggestion = suggestionsByQuestion.get(row.dimension) || {
        suggestion: row.dimension,
        impressions: 0,
        clicks: 0,
      };
      if (row.event === "suggestion_impression") suggestion.impressions += count;
      if (row.event === "suggestion_click") suggestion.clicks += count;
      suggestionsByQuestion.set(row.dimension, suggestion);
    }
  }

  const topSuggestions = [...suggestionsByQuestion.values()]
    .map((item) => ({ ...item, ctr: percentage(item.clicks, item.impressions) }))
    .sort((left, right) => right.clicks - left.clicks
      || right.impressions - left.impressions
      || left.suggestion.localeCompare(right.suggestion, "zh-CN"))
    .slice(0, 5);

  return {
    period: { days, from, to },
    totals,
    rates: {
      suggestionCtr: percentage(totals.suggestionClicks, totals.suggestionImpressions),
      chatSuccessRate: percentage(totals.chatSuccesses, totals.chatSubmits),
    },
    series: [...seriesByDay.values()],
    sections: [...sectionsById.values()],
    topSuggestions,
  };
}
