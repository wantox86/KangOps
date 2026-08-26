import { describe, expect, it } from "vitest";
import { buildWebhookRequest, type AlertableCondition } from "../src/alerts/format.js";

function condition(overrides: Partial<AlertableCondition> = {}): AlertableCondition {
  return {
    entityType: "container",
    entityId: "c1",
    code: "container_unhealthy",
    severity: "warning",
    summary: 'Container "web" is unhealthy',
    ...overrides,
  };
}

describe("buildWebhookRequest", () => {
  it("builds a generic JSON payload with the condition fields", () => {
    const request = buildWebhookRequest("generic", condition(), "local");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({ summary: 'Container "web" is unhealthy', severity: "warning", code: "container_unhealthy", hostId: "local" });
    expect(request.headers["content-type"]).toContain("application/json");
  });

  it("builds a Discord-compatible payload with a content field", () => {
    const request = buildWebhookRequest("discord", condition(), "local");
    const body = JSON.parse(request.body) as { content: string };
    expect(body.content).toContain('Container "web" is unhealthy');
    expect(body.content).toContain("WARNING");
  });

  it("builds an ntfy-compatible plain-text body with Title/Priority headers", () => {
    const request = buildWebhookRequest("ntfy", condition({ severity: "critical" }), "local");
    expect(request.body).toBe('Container "web" is unhealthy');
    expect(request.headers.title).toContain("CRITICAL");
    expect(request.headers.priority).toBe("5");
  });

  it("gives host entities a different ntfy tag than container entities", () => {
    const request = buildWebhookRequest("ntfy", condition({ entityType: "host" }), "local");
    expect(request.headers.tags).toBe("computer");
  });
});
