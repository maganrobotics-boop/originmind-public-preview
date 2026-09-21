import { PublicError } from './errors.mjs';

export const OA_ADMIN_PATH = '/api/internal/oa-admin';
export const OA_ADMIN_ORIGIN = 'https://chat.omindos.ai';
const MAX_BYTES = 8 * 1024;
const encoder = new TextEncoder();
const exactKeys = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value, minimum, maximum) => typeof value === 'string' && value.length >= minimum
  && value.length <= maximum && value.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const session = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const json = (body, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  vary: 'Authorization',
} });

async function key(secret, usages) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('OA_ADMIN_SERVICE_UNAVAILABLE');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

function signedBytes(timestamp, nonce, body) {
  return encoder.encode(`oa-admin-bridge/v1\nPOST\n${OA_ADMIN_PATH}\n${timestamp}\n${nonce}\n${body}`);
}

export async function signOaAdminRequest(body, secret, { now = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), signedBytes(timestamp, nonce, body)));
  return {
    'content-type': 'application/json', accept: 'application/json',
    'x-oa-admin-time': timestamp, 'x-oa-admin-nonce': nonce,
    authorization: `OA-ADMIN-HMAC ${Array.from(signed, byte => byte.toString(16).padStart(2, '0')).join('')}`,
  };
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
  const timestamp = request.headers.get('x-oa-admin-time') || '';
  const nonce = request.headers.get('x-oa-admin-nonce') || '';
  const signature = /^OA-ADMIN-HMAC ([a-f0-9]{64})$/u.exec(request.headers.get('authorization') || '')?.[1];
  if (!/^\d{10,12}$/u.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60
    || !/^[a-f0-9-]{36}$/u.test(nonce) || !signature || request.headers.has('origin') || request.headers.has('cookie')) return null;
  const body = await boundedBody(request);
  const signatureBytes = Uint8Array.from(signature.match(/../gu), value => parseInt(value, 16));
  if (!await crypto.subtle.verify('HMAC', await key(secret, ['verify']), signatureBytes, signedBytes(timestamp, nonce, body))) return null;
  return { body, nonce };
}

export function validOaAdminPayload(value) {
  if (exactKeys(value, ['operation'], ['sessionToken']) && value.operation === 'status') {
    return value.sessionToken === undefined || session(value.sessionToken);
  }
  if (exactKeys(value, ['operation', 'password']) && value.operation === 'login') return text(value.password, 1, 256);
  if (exactKeys(value, ['operation', 'password', 'actor']) && value.operation === 'set_password') {
    return text(value.password, 12, 256) && text(value.actor, 1, 200);
  }
  if (exactKeys(value, ['operation', 'sessionToken']) && ['logout', 'config_get', 'test'].includes(value.operation)) {
    return session(value.sessionToken);
  }
  if (exactKeys(value, ['operation', 'sessionToken', 'baseUrl', 'model'], ['apiKey']) && value.operation === 'config_save') {
    return session(value.sessionToken) && text(value.baseUrl, 0, 300)
      && /^qwen[a-zA-Z0-9_.-]{1,100}$/u.test(value.model)
      && (value.apiKey === undefined || text(value.apiKey, 0, 400));
  }
  return false;
}

export async function handleOaAdminBridge(context, engine, now = Date.now()) {
  const { request, env } = context;
  if (new URL(request.url).pathname !== OA_ADMIN_PATH || request.method !== 'POST') return json({ error: '接口不可用' }, 404);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: '请求格式不正确' }, 415);
  let authenticated;
  try { authenticated = await authenticatedBody(request, env.PUBLIC_LAB_AI_SERVICE_TOKEN, now); }
  catch { return json({ error: '服务认证失败或请求过大' }, 401); }
  if (!authenticated) return json({ error: '仅限已授权的 OA 服务' }, 401);
  let payload;
  try { payload = JSON.parse(authenticated.body); } catch { return json({ error: '请求格式不正确' }, 400); }
  if (!validOaAdminPayload(payload)) return json({ error: '请求内容不正确' }, 400);
  try {
    await engine.claimRequest(authenticated.nonce);
    return json({ received: true, ...await engine.handle(payload) });
  } catch (error) {
    if (error instanceof PublicError) return json({ error: error.message }, error.status);
    console.error('OA_ADMIN_BRIDGE_FAILED', { operation: payload.operation, type: error instanceof Error ? error.name : 'unknown' });
    return json({ error: '管理服务暂不可用，请稍后重试。' }, 503);
  }
}
