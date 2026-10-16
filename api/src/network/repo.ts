import { and, asc, eq, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { networkDevices, settings, type NetworkDevice } from "../db/schema.js";
import type { NetworkSnapshot } from "./payload.js";

export const LAST_SNAPSHOT_KEY = "network_last_snapshot_at";

// Offline devices without an alias are dropped after this long. Aliased devices are kept
// (the user said they matter); the hard cap below bounds everything else.
export const OFFLINE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_UNALIASED_DEVICES = 1000;

export interface IngestNetworkResult {
  online: number;
  newDevices: number;
  markedOffline: number;
  pruned: number;
}

// Applies one authoritative snapshot. A device missing from it is flipped offline (last_seen_at
// untouched), never deleted. alias is deliberately absent from the upsert's SET list so the
// collector can't overwrite it.
export function ingestNetworkSnapshot(db: DbClient, snapshot: NetworkSnapshot, nowIso: string): IngestNetworkResult {
  // De-dupe by MAC (router lists can repeat an entry); last one wins.
  const byMac = new Map(snapshot.devices.map((d) => [d.mac, d]));
  const existing = new Set(db.select({ mac: networkDevices.mac }).from(networkDevices).all().map((r) => r.mac));

  let newDevices = 0;
  for (const device of byMac.values()) {
    if (!existing.has(device.mac)) newDevices++;
    db.insert(networkDevices)
      .values({
        mac: device.mac,
        ip: device.ip,
        hostname: device.hostname,
        vendor: device.vendor,
        online: true,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        alias: null,
      })
      .onConflictDoUpdate({
        target: networkDevices.mac,
        set: {
          ip: device.ip,
          // A blank hostname/vendor in a later snapshot must not erase a known one.
          hostname: device.hostname ?? sql`${networkDevices.hostname}`,
          vendor: device.vendor ?? sql`${networkDevices.vendor}`,
          online: true,
          lastSeenAt: nowIso,
        },
      })
      .run();
  }

  const macs = [...byMac.keys()];
  const offlineQuery = db.update(networkDevices).set({ online: false });
  const offline =
    macs.length > 0
      ? offlineQuery.where(and(eq(networkDevices.online, true), notInArray(networkDevices.mac, macs))).run()
      : offlineQuery.where(eq(networkDevices.online, true)).run();

  const pruned = pruneNetworkDevices(db, nowIso);

  db.insert(settings)
    .values({ key: LAST_SNAPSHOT_KEY, value: nowIso, updatedAt: nowIso })
    .onConflictDoUpdate({ target: settings.key, set: { value: nowIso, updatedAt: nowIso } })
    .run();

  return { online: byMac.size, newDevices, markedOffline: offline.changes, pruned };
}

export function pruneNetworkDevices(db: DbClient, nowIso: string): number {
  const cutoff = new Date(new Date(nowIso).getTime() - OFFLINE_RETENTION_MS).toISOString();
  let pruned = db
    .delete(networkDevices)
    .where(and(eq(networkDevices.online, false), isNull(networkDevices.alias), lt(networkDevices.lastSeenAt, cutoff)))
    .run().changes;

  // Hard cap on un-aliased rows (random-MAC churn), evicting the longest-offline first.
  const unaliased = db.select({ mac: networkDevices.mac }).from(networkDevices).where(isNull(networkDevices.alias)).all().length;
  const excess = unaliased - MAX_UNALIASED_DEVICES;
  if (excess > 0) {
    const victims = db
      .select({ mac: networkDevices.mac })
      .from(networkDevices)
      .where(and(eq(networkDevices.online, false), isNull(networkDevices.alias)))
      .orderBy(asc(networkDevices.lastSeenAt))
      .limit(excess)
      .all()
      .map((r) => r.mac);
    for (const mac of victims) {
      pruned += db.delete(networkDevices).where(eq(networkDevices.mac, mac)).run().changes;
    }
  }
  return pruned;
}

export function listNetworkDevices(db: DbClient): NetworkDevice[] {
  return db.select().from(networkDevices).all();
}

export function setDeviceAlias(db: DbClient, mac: string, alias: string | null): NetworkDevice | undefined {
  const trimmed = alias?.trim();
  const value = trimmed ? trimmed : null;
  const updated = db.update(networkDevices).set({ alias: value }).where(eq(networkDevices.mac, mac)).returning().all()[0];
  return updated;
}

export function getLastSnapshotAt(db: DbClient): string | null {
  return db.select().from(settings).where(eq(settings.key, LAST_SNAPSHOT_KEY)).all()[0]?.value ?? null;
}
