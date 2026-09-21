import { validTaskInput, validTaskResult } from '../lib/ai-workbench-core.mjs';
import { taskFailureDiagnostic } from '../lib/ai-workbench-diagnostics.mjs';
import { PublicError } from './errors.mjs';
import { executeTaskTools } from '../lib/ai-workbench-tools.mjs';
import { createTaskToolModel } from './task-tool-model.mjs';
import { decryptSecret } from './crypto.mjs';
import { fallbackAnswer, aliyunEndpoint } from './knowledge.mjs';
import { generateValidatedAnswer } from './answer-retry.mjs';
import { answerMode } from './answer-mode.mjs';

export const OA_CHAT_PATH = '/api/internal/oa-answer';
export const OA_CHAT_ORIGIN = 'https://chat.omindos.ai';
const MAX_BYTES = 96 * 1024;
const encoder = new TextEncoder();
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && value.isWellFormed();
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'vary': 'Authorization' } });

async function key(secret, usages) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('OA_CHAT_SERVICE_UNAVAILABLE');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
function signedBytes(timestamp, nonce, body) {
  return encoder.encode(`oa-chat-bridge/v1\nPOST\n${OA_CHAT_PATH}\n${timestamp}\n${nonce}\n${body}`);
}
export async function signOaChatRequest(body, secret, { now = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), signedBytes(timestamp, nonce, body)));
  return { 'content-type': 'application/json', accept: 'application/json', 'x-oa-chat-time': timestamp, 'x-oa-chat-nonce': nonce, authorization: `OA-HMAC ${Array.from(signed, byte => byte.toString(16).padStart(2, '0')).join('')}` };
}
async function boundedBody(request) {
  if (!request.body) throw new Error('EMPTY_BODY');
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function authenticatedBody(request, secret, now) {
  const timestamp = request.headers.get('x-oa-chat-time') || '';
  const nonce = request.headers.get('x-oa-chat-nonce') || '';
  const signature = /^OA-HMAC ([a-f0-9]{64})$/u.exec(request.headers.get('authorization') || '')?.[1];
  if (!/^\d{10,12}$/u.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60 || !/^[a-f0-9-]{36}$/u.test(nonce) || !signature || request.headers.has('origin') || request.headers.has('cookie')) return null;
  const body = await boundedBody(request);
  const bytes = Uint8Array.from(signature.match(/../gu), value => parseInt(value, 16));
  if (!await crypto.subtle.verify('HMAC', await key(secret, ['verify']), bytes, signedBytes(timestamp, nonce, body))) return null;
  return { body, nonce };
}
export function validOaChatPayload(value) {
  if (exactKeys(value, ['operation', 'task']) && value.operation === 'task') return validTaskInput(value.task);
  if (exactKeys(value, ['operation']) && value.operation === 'status') return true;
  const answerType = value?.answerType || 'grounded';
  if (!exactKeys(value, ['operation', 'answerType', 'question', 'history', 'documents']) || value.operation !== 'answer' || !['grounded', 'general'].includes(answerType) || !text(value.question, 2000) || value.question.trim().length < 2 || !Array.isArray(value.history) || value.history.length > 2 || !Array.isArray(value.documents) || value.documents.length > 6) return false;
  if (value.history.some(item => !exactKeys(item, ['role', 'content']) || item.role !== 'user' || !text(item.content, 2000))) return false;
  if (answerType === 'general' && value.documents.length !== 0) return false;
  return value.documents.every(item => exactKeys(item, ['id', 'title', 'body', 'updatedAt', 'origin', 'assets']) && text(item.id, 100) && text(item.title, 300) && text(item.body, 3500) && text(item.updatedAt, 40) && ['oa_internal', 'oa_public'].includes(item.origin) && Array.isArray(item.assets) && item.assets.length <= 8 && item.assets.every(asset => exactKeys(asset, ['alt']) && text(asset.alt, 300)));
}

/** The public chat route never calls this handler. No conversations, evidence,
 * source names or answers are written to Chat's public data, cache or analytics. */
export async function handleOaChatBridge(context, engine, now = Date.now()) {
  const { request, env } = context;
  if (new URL(request.url).pathname !== OA_CHAT_PATH || request.method !== 'POST') return json({ error: '接口不可用' }, 404);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: '请求格式不正确' }, 415);
  let authenticated;
  try { authenticated = await authenticatedBody(request, env.PUBLIC_LAB_AI_SERVICE_TOKEN, now); }
  catch { return json({ error: '服务认证失败或请求过大' }, 401); }
  if (!authenticated) return json({ error: '仅限已授权的 OA 服务' }, 401);
  let payload;
  try { payload = JSON.parse(authenticated.body); } catch { return json({ error: '请求格式不正确' }, 400); }
  if (!validOaChatPayload(payload)) return json({ error: '请求内容不正确' }, 400);
  let taskPhase = 'request_claim';
  try {
    await engine.claimRequest(authenticated.nonce);
    taskPhase = 'config_read';
    const config = await engine.getModelConfig(context);
    taskPhase = 'provider_selection';
    const active = engine.modelProvider(context, config);
    if (payload.operation === 'status') {
      const [model, budgetReady] = await Promise.all([engine.currentModelStatus(context, config, active), engine.modelBudgetReady(context)]);
      return json({ received: true, bridgeReady: true, modelReady: model.ready === true && model.probePending !== true, budgetReady: budgetReady === true });
    }
    if (payload.operation === 'task') {
      // Private, allowlisted tools only. Never quietly change the model provider.
      if (active.provider !== 'bailian') return json({ error: '任务需要已配置的百炼模型' }, 503);
      const deadline = Date.now() + 60000;
      taskPhase = 'endpoint_validation';
      const endpoint = aliyunEndpoint(config.baseUrl);
      taskPhase = 'key_decryption';
      const apiKey = await decryptSecret(config.encryptedKey, env.APP_ENCRYPTION_KEY);
      taskPhase = 'model_configuration';
      const transport = createTaskToolModel({
        endpoint, apiKey,
        model: config.model,
        fetcher: (...args) => context.runtime.fetch(...args),
        consumeBudget: async () => {
          taskPhase = 'budget';
          try { await engine.globalBudget(context); }
          catch (error) {
            // Only the actual application limiter's rejection is exhaustion.
            // A database failure is not evidence that the allowance was used up.
            throw new Error(error instanceof PublicError && error.status === 429
              ? 'TASK_BUDGET_EXHAUSTED' : 'TASK_BUDGET_UNAVAILABLE');
          }
          taskPhase = 'model_request';
        },
      });
      const callModel = async args => {
        taskPhase = 'model_request';
        const reply = await transport(args);
        taskPhase = 'tool_execution';
        return reply;
      };
      taskPhase = 'tool_execution';
      const result = await executeTaskTools(payload.task, callModel, { deadline });
      if (!validTaskResult(result.answer)) return json({ error: '任务未生成完整可用成果' }, 502);
      // "prepared" is not "saved": the OA task store rechecks owner/NDA/revision
      // and cancellation before persisting. No tool creates an external side effect.
      return json({ received: true, ...result, mode: 'task', provider: 'bailian' });
    }
    const fallback = reason => json({ received: true, answer: fallbackAnswer(payload.documents), mode: 'retrieval', fallbackReason: reason });
    const answerType = payload.answerType || 'grounded';
    if (answerType === 'grounded' && !payload.documents.length) return fallback('no_documents');
    if (!active.provider) return fallback('model_unavailable');
    await engine.globalBudget(context);
    const { buildGeneralChatMessages, buildGroundedChatMessages } = await import('./grounded-prompt.mjs');
    const messages = answerType === 'general'
      ? buildGeneralChatMessages({ question: payload.question, messages: [...payload.history, { role: 'user', content: payload.question }] })
      : buildGroundedChatMessages({ documents: payload.documents, history: [], question: payload.question, messages: [...payload.history, { role: 'user', content: payload.question }], scope: 'internal' });
    const selectedMode = answerMode(payload.question);
    context.modelDeadline = Date.now() + (selectedMode === 'deep' ? 75000 : 45000);
    let provider = active.provider;
    const generated = await generateValidatedAnswer({
      messages,
      retryInstruction: answerType === 'general' ? undefined : '\n\n上一次生成结果未能通过完整性或资料引用校验。请重新独立作答：只输出完整正文；每个资料事实后紧跟有效的 [编号]；至少使用一个有效编号；不要输出参考资料列表、网址、联系方式、HTML 或未完成的句子。',
      generate: async attemptMessages => {
        if (selectedMode === 'deep' && typeof env.AI?.run === 'function') {
          provider = 'workers-ai';
          return engine.workersAiCall(context, attemptMessages, 2400);
        }
        if (provider === 'bailian') {
        try { return await engine.modelCall(context, config, attemptMessages); }
        catch (error) {
          if (typeof env.AI?.run !== 'function') throw error;
            provider = 'workers-ai'; return engine.workersAiCall(context, attemptMessages);
        }
        }
        return engine.workersAiCall(context, attemptMessages);
      },
      validate: answer => answerType === 'general' ? engine.visibleGeneralAnswer(answer) : engine.visibleAiAnswer(answer, payload.documents.length),
    });
    if (!generated.visible) return fallback(generated.failureReason);
    return json({ received: true, answer: generated.visible, mode: answerType === 'general' ? 'general' : 'ai', provider, answerMode: selectedMode });
  } catch (error) {
    if (payload.operation !== 'task') return json({ error: '问答服务暂不可用，请稍后重试' }, 503);
    const diagnostic = taskFailureDiagnostic(error, taskPhase);
    // Authenticated task service only. No raw errors, messages, URLs, keys,
    // model responses or member material may enter logs or the response.
    console.error(`OA_TASK_FAILED ${JSON.stringify(diagnostic)}`);
    // Preserve the existing HTTP/error contract for older OA clients. The
    // versioned diagnostic carries the actual failure instead of guessing.
    return json({ error: '问答服务暂不可用，请稍后重试', diagnostic }, 503);
  }
}
