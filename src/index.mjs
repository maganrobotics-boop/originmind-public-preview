import { handleRequest } from "./app.mjs";
import { hardenResponse, routeStaticRequest } from "./static-router.mjs";

export { handleRequest } from "./app.mjs";

export default {
  async fetch(request, env, executionContext) {
    let expectedOrigin;
    try {
      expectedOrigin = new URL(env.APP_ORIGIN).origin;
    } catch {
      return hardenResponse(Response.json({ error: "服务暂时不可用，请稍后重试。" }, { status: 503 }));
    }
    if (new URL(request.url).origin !== expectedOrigin) {
      return hardenResponse(Response.json({ error: "请求域名不正确" }, { status: 421 }));
    }
    const staticResponse = await routeStaticRequest(request, env);
    if (staticResponse) return staticResponse;
    return hardenResponse(await handleRequest(request, env, executionContext));
  },
};
