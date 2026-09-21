export const APP_NAME = "arts-robotics-ai-assistant";
export const DEFAULT_MODEL = "qwen-plus";
export const WORKERS_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const OA_PUBLIC_RETRIEVE_URL = "https://oa.omindos.ai/api/public/lab-ai/retrieve";
export const OA_PUBLIC_SUGGESTIONS_URL = "https://oa.omindos.ai/api/public/lab-ai/suggestions";
export const OA_PUBLIC_STATUS_URL = "https://oa.omindos.ai/api/public/lab-ai/status";
export const PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

export const TOPICS = Object.freeze(["student", "research", "business"]);
export const INQUIRY_STATUSES = Object.freeze(["pending", "replied", "closed"]);
