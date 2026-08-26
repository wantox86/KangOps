import type { Container, NewContainer, NewEvent } from "../db/schema.js";
import type { NormalizedContainer } from "../docker/types.js";

export interface DiffResult {
  upsert: NewContainer;
  events: Array<Omit<NewEvent, "id" | "hostId">>;
}

// Pure function: given a freshly observed container and the previously persisted row (if any),
// decide what to write and which lifecycle events that transition deserves. Kept side-effect
// free and independently testable per CLAUDE.md's testing strategy (no DB/Docker mocking
// needed to verify this logic).
export function diffContainer(observed: NormalizedContainer, previous: Container | undefined, nowIso: string): DiffResult {
  const events: Array<Omit<NewEvent, "id" | "hostId">> = [];

  if (!previous) {
    events.push({
      containerId: observed.dockerId,
      occurredAt: nowIso,
      source: "collector",
      type: "container_discovered",
      severity: "info",
      summary: `Discovered container "${observed.name}" (${observed.state})`,
      metadataJson: null,
    });
  } else {
    if (previous.currentState !== observed.state) {
      events.push({
        containerId: observed.dockerId,
        occurredAt: nowIso,
        source: "collector",
        type: "state_changed",
        severity: observed.state === "running" ? "info" : "warning",
        summary: `"${observed.name}" state changed: ${previous.currentState} -> ${observed.state}`,
        metadataJson: JSON.stringify({ from: previous.currentState, to: observed.state }),
      });
    }
    if (previous.currentHealth !== observed.health) {
      events.push({
        containerId: observed.dockerId,
        occurredAt: nowIso,
        source: "collector",
        type: "health_changed",
        severity: observed.health === "unhealthy" ? "critical" : "info",
        summary: `"${observed.name}" health changed: ${previous.currentHealth} -> ${observed.health}`,
        metadataJson: JSON.stringify({ from: previous.currentHealth, to: observed.health }),
      });
    }
    if (previous.restartCount < observed.restartCount) {
      events.push({
        containerId: observed.dockerId,
        occurredAt: nowIso,
        source: "collector",
        type: "container_restarted",
        severity: "warning",
        summary: `"${observed.name}" restarted (restart count ${previous.restartCount} -> ${observed.restartCount})`,
        metadataJson: null,
      });
    }
  }

  return {
    upsert: {
      dockerId: observed.dockerId,
      hostId: previous?.hostId ?? "",
      currentName: observed.name,
      imageRef: observed.image,
      imageDigest: observed.imageDigest,
      composeProject: observed.composeProject,
      composeService: observed.composeService,
      currentState: observed.state,
      currentHealth: observed.health,
      restartCount: observed.restartCount,
      critical: previous?.critical ?? false,
      firstSeenAt: previous?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
    },
    events,
  };
}

// Containers that were previously seen but are absent from this cycle's observation (removed,
// or the daemon stopped reporting them) -- marked "removed" so the dashboard doesn't keep
// showing stale "running" state forever, with one event recorded per disappearance.
export function diffMissing(missing: Container, nowIso: string): DiffResult {
  return {
    upsert: { ...missing, currentState: "removed", lastSeenAt: nowIso },
    events:
      missing.currentState === "removed"
        ? []
        : [
            {
              containerId: missing.dockerId,
              occurredAt: nowIso,
              source: "collector",
              type: "container_removed",
              severity: "warning",
              summary: `"${missing.currentName}" is no longer reported by Docker`,
              metadataJson: null,
            },
          ],
  };
}
