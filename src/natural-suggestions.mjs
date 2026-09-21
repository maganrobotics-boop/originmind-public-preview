import { decryptSecret, encryptSecret } from "./crypto.mjs";
import { retrieveOa, suggestionKnowledgeReference, suggestionMatchesKnowledge } from "./oa-public.mjs";
import { OVERVIEW_QUESTIONS, overviewQuestions, suggestionEvidenceText } from "./suggestion-excerpts.mjs";

const PURPOSE = "arts-public-suggestion-v1";
const TOKEN_TTL_MS = 10 * 60_000;
const MAX_SUGGESTIONS = 5;
const DAY_MS = 24 * 60 * 60 * 1_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

// Ask about concepts present in approved excerpts. Never interpolate upload
// titles, filenames, or arbitrary source text into a visitor-facing question.
// Specific questions take priority; substantive unfamiliar topics get only a
// source-bound overview, never invented facts or unconditional filler.
const QUESTIONS = [
  [[/无\s*(?:GNSS|GPS)|没有卫星信号|无卫星信号/iu, /定位/u], [
    "没有卫星信号时，机器人怎么定位？",
    "没有卫星信号，机器人靠什么可靠定位？",
  ]],
  [[/RTK/iu, /激光雷达|LiDAR/iu, /惯性|IMU/iu], [
    "激光雷达、惯性传感器和 RTK 如何协同定位？",
    "激光雷达、IMU 与 RTK 怎样融合定位？",
  ]],
  [[/触觉|tactile/iu, /抓取|抓握|操作|grasp|manipulation/iu], [
    "触觉反馈能怎样帮助机器人抓稳物体？",
    "机器人抓取时，触觉反馈起什么作用？",
  ]],
  [[/视觉|vision/iu, /抓取|grasp/iu], [
    "机器人怎样通过视觉找到并抓取物体？",
    "视觉如何帮助机器人完成准确抓取？",
  ]],
  [[/双臂|dual.arm|bimanual/iu, /协作|协调|coordinat/iu], [
    "两条机械臂怎样配合完成操作任务？",
    "双臂机器人如何协调完成复杂操作？",
  ]],
  [[/机械臂|机器人|robot/iu, /运动规划|motion planning/iu], [
    "机器人怎样规划完成任务的动作轨迹？",
    "机器人的动作轨迹是怎样规划出来的？",
  ]],
  [[/四足/u, /矿井|矿区|井下/u, /巡检/u], [
    "四足机器人能在矿井里完成哪些巡检任务？",
    "矿井中的四足机器人主要承担哪些巡检工作？",
  ]],
  [[/矿井|矿区|井下/u, /巡检/u], [
    "矿井巡检机器人主要检查哪些内容？",
    "机器人在矿区巡检时重点关注什么？",
  ]],
  [[/三维重建|3D reconstruction/iu], [
    "机器人怎样把周围环境重建成三维地图？",
    "机器人如何生成周围环境的三维地图？",
  ]],
  [[/自主导航/u, /避障|路径规划/u], [
    "机器人怎样自主规划路线并避开障碍？",
    "自主导航机器人如何选路和避障？",
  ]],
  [[/OriginMind|OmindOS|Robot Agent OS/iu, /技能|任务|调度/u], [
    "OriginMind 怎样组织机器人的技能和任务？",
    "OriginMind 如何调度机器人技能完成任务？",
  ]],
  [[/语音/u, /导航|操作/u], [
    "怎样让机器人听懂指令并执行任务？",
    "机器人如何把语音指令转成导航或操作？",
  ]],
  [[/故障|失败|退化/u, /恢复/u], [
    "机器人遇到故障后怎样恢复任务？",
    "任务失败后，机器人如何自主恢复？",
  ]],
  [[/灵巧操作|dexterous manipulation/iu], [
    "让机器人完成灵巧操作，关键要解决哪些问题？",
    "机器人实现灵巧操作需要突破哪些关键点？",
  ]],
  [[/协作机器人/u, /安全/u], [
    "人和协作机器人一起工作时，怎样保障安全？",
    "协作机器人与人共同作业时如何确保安全？",
  ]],
  [[/协会/u, /活动|实践|竞赛/u], [
    "协会有哪些机器人实践活动？",
    "学生可以参加哪些机器人创新实践？",
  ]],
  [[/实验室|ARTS\s*Robotics|课题组/iu, /机器人|机械臂|四足|移动底盘|移动机器人/iu], [
    "实验室目前有哪些机器人设备？",
    "实验室现有机器人平台包括哪些？",
  ]],
  [[/研究方向|研究内容|研究领域/u, /机器人|具身智能|自主系统|人形/u], [
    "实验室主要研究哪些机器人方向？",
    "团队当前关注哪些机器人研究方向？",
  ]],
  [[/研究/u, /提出|方法/u], [
    "这项研究主要解决什么问题？",
    "这项研究提出了什么方法，解决了什么难题？",
  ]],
  [[/项目|产品/u, /应用|场景/u], [
    "这个项目适合用在哪些场景？",
    "这项机器人项目可以落地到哪些应用场景？",
  ]],
];

const QUESTION_TEXTS = new Set([...QUESTIONS.flatMap(([, variants]) => variants), ...OVERVIEW_QUESTIONS]);

export function isNaturalSuggestionQuestion(value) {
  return typeof value === "string" && QUESTION_TEXTS.has(value);
}

export function suggestionDayOrdinal(now = new Date()) {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("INVALID_SUGGESTION_DATE");
  return Math.floor((timestamp + BEIJING_UTC_OFFSET_MS) / DAY_MS);
}

export function naturalQuestions(documents, now = new Date()) {
  const excerpts = documents.map((document) => suggestionEvidenceText(document.body));
  const day = suggestionDayOrdinal(now);
  const questions = QUESTIONS.filter(([patterns]) => excerpts.some((excerpt) => patterns.every((pattern) => pattern.test(excerpt))))
    .map(([, variants]) => variants[((day % variants.length) + variants.length) % variants.length]);
  return questions.length ? questions : overviewQuestions(excerpts, day);
}

export function parseChatSuggestions(value) {
  if (!Array.isArray(value) || value.length > MAX_SUGGESTIONS) throw new Error("INVALID_SUGGESTIONS");
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || Object.keys(item).sort().join(",") !== "id,question,suggestionToken,updatedAt"
      || item.id !== String(index + 1) || !QUESTION_TEXTS.has(item.question)
      || seen.has(item.question) || !/^\d{4}-\d{2}-\d{2}$/u.test(item.updatedAt)
      || new Date(`${item.updatedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== item.updatedAt
      || typeof item.suggestionToken !== "string" || item.suggestionToken.length > 4_000
      || !/^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/u.test(item.suggestionToken)) {
      throw new Error("INVALID_SUGGESTIONS");
    }
    seen.add(item.question);
    return item;
  });
}

export async function naturalizeSuggestions(result, context, deadline = Date.now() + 13_000, now = new Date()) {
  if (result.status !== "connected") return result;
  const candidates = await Promise.all(result.suggestions.map(async (suggestion) => {
    const retrieved = await retrieveOa(suggestion.question, context, Math.max(1, deadline - Date.now()));
    if (retrieved.status !== "connected") return { suggestion, status: retrieved.status, questions: [] };
    const documents = retrieved.documents.filter((document) => suggestionMatchesKnowledge(suggestion.question, document));
    return { suggestion, status: "connected", questions: naturalQuestions(documents, now) };
  }));
  // Keep specific questions ahead of the optional source-bound overview.
  candidates.sort((left, right) => Number(OVERVIEW_QUESTIONS.includes(left.questions[0]))
    - Number(OVERVIEW_QUESTIONS.includes(right.questions[0])));
  const suggestions = [];
  const seen = new Set();
  const maximumQuestions = Math.max(0, ...candidates.map((candidate) => candidate.questions.length));
  outer: for (let questionIndex = 0; questionIndex < maximumQuestions; questionIndex += 1) {
    for (const candidate of candidates) {
      const question = candidate.questions[questionIndex];
      if (!question || seen.has(question)) continue;
      seen.add(question);
      const suggestionToken = await encryptSecret(JSON.stringify({
        purpose: PURPOSE,
        question,
        retrievalQuestion: candidate.suggestion.question,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      }), context.env.APP_ENCRYPTION_KEY);
      suggestions.push({
        id: String(suggestions.length + 1),
        question,
        updatedAt: candidate.suggestion.updatedAt,
        suggestionToken,
      });
      if (suggestions.length === MAX_SUGGESTIONS) break outer;
    }
  }
  // A successful list request does not make failed per-source retrieval healthy.
  const failure = candidates.find((candidate) => candidate.status !== "connected");
  return { status: !suggestions.length && failure ? failure.status : "connected", suggestions };
}

export async function suggestionRetrievalQuestion(token, question, secret) {
  try {
    const value = JSON.parse(await decryptSecret(token, secret));
    if (value.purpose !== PURPOSE || value.question !== question || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + TOKEN_TTL_MS
      || !suggestionKnowledgeReference(value.retrievalQuestion)) return null;
    return value.retrievalQuestion;
  } catch {
    return null;
  }
}
