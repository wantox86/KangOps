import type { WebhookRequest } from "./format.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SendResult {
  ok: boolean;
  error: string | null;
}

// Never log the URL itself (it's the secret) -- callers pass it straight through to fetch and
// only ever log/store the boolean/error outcome. AbortController bounds a hung endpoint the
// same way collector/loop.ts's withTimeout bounds a hung Docker call.
export async function sendWebhook(url: string, request: WebhookRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `webhook responded with HTTP ${response.status}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
