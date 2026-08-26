import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../db/client.js";
import { fetchLatestDigest } from "./dockerHubClient.js";
import { getImageMetadata, upsertImageMetadata } from "./metadataRepo.js";
import { parseImageRef } from "./parseRef.js";

// Registry checks are deliberately much coarser than the ~20s collector cadence -- a per-tick
// check would hammer Docker Hub's anonymous rate limits for no benefit (image digests don't
// change that often). Checked against each image's own lastCheckedAt, not a separate scheduler
// -- same "no separate scheduler, cheap to check every tick" pattern as metrics/runRetention.ts.
export const RECHECK_INTERVAL_MS = 6 * 60 * 60_000; // 6h

function needsRecheck(lastCheckedAt: string | null, nowIso: string): boolean {
  if (!lastCheckedAt) return true;
  return new Date(nowIso).getTime() - new Date(lastCheckedAt).getTime() >= RECHECK_INTERVAL_MS;
}

// Only ever called when images/registryConfigRepo.ts's enabled flag is true -- callers (the
// collector loop) are responsible for that gate, kept out of this function so it stays a plain
// "check these refs" primitive that's easy to unit-test without settings-table plumbing.
export async function runImageChecks(db: DbClient, imageRefs: string[], nowIso: string, logger?: FastifyBaseLogger): Promise<void> {
  const uniqueRefs = [...new Set(imageRefs)];

  for (const imageRef of uniqueRefs) {
    const existing = getImageMetadata(db, imageRef);
    if (existing && !needsRecheck(existing.lastCheckedAt, nowIso)) continue;

    const parsed = parseImageRef(imageRef);
    if (!parsed) {
      upsertImageMetadata(db, {
        imageRef,
        registrySupported: false,
        latestDigest: null,
        updateAvailable: null,
        lastCheckedAt: nowIso,
        checkError: "unsupported registry (only unauthenticated Docker Hub image refs are checked)",
        createdAt: existing?.createdAt ?? nowIso,
      });
      continue;
    }

    try {
      const result = await fetchLatestDigest(parsed);
      upsertImageMetadata(db, {
        imageRef,
        registrySupported: true,
        latestDigest: result.digest,
        // updateAvailable is recomputed per-container at read time (routes/images.ts) against
        // each container's own observed digest -- this cached column isn't authoritative, just
        // a coarse "did the last check find a digest at all" signal.
        updateAvailable: null,
        lastCheckedAt: nowIso,
        checkError: result.error,
        createdAt: existing?.createdAt ?? nowIso,
      });
    } catch (err) {
      logger?.warn({ err, imageRef }, "registry digest check failed");
      upsertImageMetadata(db, {
        imageRef,
        registrySupported: true,
        latestDigest: existing?.latestDigest ?? null,
        updateAvailable: null,
        lastCheckedAt: nowIso,
        checkError: err instanceof Error ? err.message : String(err),
        createdAt: existing?.createdAt ?? nowIso,
      });
    }
  }
}
