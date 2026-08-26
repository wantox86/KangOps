import type { DockerHubRef } from "./parseRef.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface DigestLookupResult {
  digest: string | null;
  error: string | null;
}

// Docker Hub's public v2 API, unauthenticated (works for public images/rate-limited anonymous
// pulls, which is exactly the "public image freshness check" this feature promises -- no
// registry credentials are ever requested or stored). Only called when a user has explicitly
// enabled registry checks (images/registryConfigRepo.ts) -- never on by default, per CLAUDE.md's
// "opt-in" requirement and the "graceful degradation... missing optional capabilities... must
// not break core monitoring" principle (a failure here just means "unknown", not a crash).
export async function fetchLatestDigest(ref: DockerHubRef, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DigestLookupResult> {
  const url = `https://hub.docker.com/v2/repositories/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.repo)}/tags/${encodeURIComponent(ref.tag)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      return { digest: null, error: `Docker Hub responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { digest?: string; images?: Array<{ digest?: string }> };
    const digest = body.digest ?? body.images?.[0]?.digest ?? null;
    return { digest, error: digest ? null : "response did not include a digest" };
  } catch (err) {
    return { digest: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
