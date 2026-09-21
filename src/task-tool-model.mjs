/** Bailian tool-call transport. No fallback, redirects, SDK auto-retries, logs,
 * or credentials in model messages. The caller supplies server-validated config.
 */
export function createTaskToolModel({ endpoint, apiKey, model, fetcher, consumeBudget, now = Date.now }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      (url.hostname !== 'dashscope.aliyuncs.com' && !/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(url.hostname)) ||
      url.pathname !== '/compatible-mode/v1' || typeof apiKey !== 'string' || !apiKey.trim() ||
      typeof model !== 'string' || !model.trim() || typeof fetcher !== 'function' || typeof consumeBudget !== 'function') throw new Error('TASK_MODEL_CONFIG');
  return async ({ messages, tools, deadline }) => {
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('TASK_TOOL_TIMEOUT');
    const body = JSON.stringify({ model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false, temperature: 0.2, max_tokens: 6000, enable_thinking: false, stream: false });
    if (new TextEncoder().encode(body).length > 204800) throw new Error('TASK_TOOL_CONTEXT_LIMIT');
    // Each upstream attempt consumes a budget unit, not just each user task.
    await consumeBudget();
    const timeout = Math.min(60000, deadline - now());
    if (timeout <= 0) throw new Error('TASK_TOOL_TIMEOUT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response, reader;
    try {
      response = await fetcher(`${url.href}/chat/completions`, { method: 'POST', headers: {
        authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json',
      }, body, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      // Keep only the numeric status; do not read an upstream error body.
      if (!response.ok) throw Object.assign(new Error('TASK_MODEL_HTTP'), { upstreamStatus: response.status });
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('TASK_MODEL_PROTOCOL');
      if (Number(response.headers.get('content-length') || 0) > 262144 || !response.body) throw new Error('TASK_MODEL_RESPONSE_LIMIT');
      reader = response.body.getReader(); let length = 0; const parts = [];
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 262144) throw new Error('TASK_MODEL_RESPONSE_LIMIT');
        parts.push(value);
      }
      if (now() >= deadline || controller.signal.aborted) throw new Error('TASK_TOOL_TIMEOUT');
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Error('TASK_MODEL_PROTOCOL'); }
      if (!Array.isArray(value?.choices) || value.choices.length !== 1 || !value.choices[0]?.message) throw new Error('TASK_MODEL_PROTOCOL');
      return { message: value.choices[0].message, finishReason: value.choices[0].finish_reason };
    } catch (error) {
      // Do not turn a timeout, failed fetch, or broken response stream into HTTP.
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('TASK_TOOL_TIMEOUT');
      if (error instanceof TypeError) throw new Error('TASK_MODEL_TRANSPORT');
      throw error;
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
    }
  };
}
