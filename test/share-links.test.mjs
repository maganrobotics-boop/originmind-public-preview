import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/app.mjs';
import { D1DatabaseAdapter } from './d1-adapter.mjs';

const origin = 'https://chat.omindos.ai';
const env = db => ({ DB: db, APP_ORIGIN: origin, ADMIN_EMAIL: 'owner@example.test', APP_ENCRYPTION_KEY: 'e'.repeat(48), RATE_LIMIT_HMAC_KEY: 'r'.repeat(48) });
const request = (path, method = 'GET', body) => new Request(`${origin}${path}`, { method, headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.45' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('public answer snapshots use bounded expiring short links', async t => {
  const db = new D1DatabaseAdapter(); t.after(() => db.close());
  const created = await handleRequest(request('/api/shares', 'POST', { question: '机器人如何运动？', answer: '通过运动控制算法。' }), env(db), {});
  assert.equal(created.status, 201);
  const saved = await created.json(); assert.match(saved.id, /^[a-f0-9]{16}$/u);
  const opened = await handleRequest(request(`/api/shares/${saved.id}`), env(db), {});
  assert.equal(opened.status, 200);
  const snapshot = await opened.json();
  assert.deepEqual({ v: snapshot.v, question: snapshot.question, answer: snapshot.answer }, { v: 1, question: '机器人如何运动？', answer: '通过运动控制算法。' });
});

test('short-share API rejects cross-site writes and unknown identifiers', async t => {
  const db = new D1DatabaseAdapter(); t.after(() => db.close());
  const crossSite = new Request(`${origin}/api/shares`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.46' }, body: JSON.stringify({ question: '问题', answer: '回答' }) });
  assert.equal((await handleRequest(crossSite, env(db), {})).status, 403);
  assert.equal((await handleRequest(request('/api/shares/0000000000000000'), env(db), {})).status, 404);
});
