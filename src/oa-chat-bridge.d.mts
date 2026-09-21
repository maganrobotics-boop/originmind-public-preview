export const OA_CHAT_PATH: string;
export const OA_CHAT_ORIGIN: string;
export function signOaChatRequest(body: string, secret: string, options?: { now?: number; nonce?: string }): Promise<Record<string, string>>;
