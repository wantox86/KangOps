import { describe, expect, it } from "vitest";
import { diffContainer, diffMissing } from "../src/collector/diff.js";
import type { Container } from "../src/db/schema.js";
import type { NormalizedContainer } from "../src/docker/types.js";

const observed: NormalizedContainer = {
  dockerId: "c1",
  name: "web",
  image: "nginx:1.27",
  imageDigest: null,
  state: "running",
  health: "healthy",
  composeProject: "proj",
  composeService: "web",
  startedAt: "2026-01-01T00:00:00.000Z",
  restartCount: 0,
};

const baseRow: Container = {
  dockerId: "c1",
  hostId: "local",
  currentName: "web",
  imageRef: "nginx:1.27",
  imageDigest: null,
  composeProject: "proj",
  composeService: "web",
  currentState: "running",
  currentHealth: "healthy",
  restartCount: 0,
  critical: false,
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
};

describe("diffContainer", () => {
  it("emits container_discovered for a never-seen container", () => {
    const result = diffContainer(observed, undefined, "2026-01-02T00:00:00.000Z");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("container_discovered");
    expect(result.upsert.firstSeenAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("emits no events when nothing changed", () => {
    const result = diffContainer(observed, baseRow, "2026-01-02T00:00:00.000Z");
    expect(result.events).toHaveLength(0);
    expect(result.upsert.firstSeenAt).toBe(baseRow.firstSeenAt);
  });

  it("emits state_changed when state differs", () => {
    const result = diffContainer({ ...observed, state: "exited" }, baseRow, "2026-01-02T00:00:00.000Z");
    expect(result.events.map((e) => e.type)).toContain("state_changed");
  });

  it("emits health_changed with critical severity when becoming unhealthy", () => {
    const result = diffContainer({ ...observed, health: "unhealthy" }, baseRow, "2026-01-02T00:00:00.000Z");
    const event = result.events.find((e) => e.type === "health_changed");
    expect(event?.severity).toBe("critical");
  });

  it("emits container_restarted when restart count increases", () => {
    const result = diffContainer({ ...observed, restartCount: 1 }, baseRow, "2026-01-02T00:00:00.000Z");
    expect(result.events.map((e) => e.type)).toContain("container_restarted");
  });

  it("preserves critical flag from the previous row", () => {
    const result = diffContainer(observed, { ...baseRow, critical: true }, "2026-01-02T00:00:00.000Z");
    expect(result.upsert.critical).toBe(true);
  });
});

describe("diffMissing", () => {
  it("marks a previously-running container as removed and emits an event", () => {
    const result = diffMissing(baseRow, "2026-01-02T00:00:00.000Z");
    expect(result.upsert.currentState).toBe("removed");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("container_removed");
  });

  it("emits no duplicate event if already marked removed", () => {
    const result = diffMissing({ ...baseRow, currentState: "removed" }, "2026-01-02T00:00:00.000Z");
    expect(result.events).toHaveLength(0);
  });
});
