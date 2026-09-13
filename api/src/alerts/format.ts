import type { WebhookFormat } from "./types.js";

export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

// Narrower than health/types.ts's HealthConditionInput on purpose -- alerts only ever need these
// 5 fields (no `penalty`/`evidence`), and this shape is satisfied directly by both a freshly
// evaluated condition and a reconcile.ts NewHealthCondition row, so callers never need to
// reshape one into the other just to send an alert.
export interface AlertableCondition {
  entityType: string;
  entityId: string;
  code: string;
  severity: string;
  summary: string;
}

// Pure formatting for the 3 supported destinations -- "generic" is a plain JSON POST any
// automation can consume, "discord" matches Discord's incoming-webhook `content` field,
// "ntfy" matches ntfy.sh's plain-text-body + header convention (Title/Priority/Tags). Kept as
// pure string-building (no fetch) so it's unit-testable without a network mock.
export function buildWebhookRequest(format: WebhookFormat, condition: AlertableCondition, hostId: string): WebhookRequest {
  const title = `[KangOps] ${condition.severity.toUpperCase()}: ${condition.code}`;

  if (format === "discord") {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `**${title}**\n${condition.summary}` }),
    };
  }

  if (format === "ntfy") {
    return {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        title,
        priority: condition.severity === "critical" ? "5" : condition.severity === "warning" ? "4" : "3",
        tags: condition.entityType === "container" ? "whale" : "computer",
      },
      body: condition.summary,
    };
  }

  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      summary: condition.summary,
      severity: condition.severity,
      entityType: condition.entityType,
      entityId: condition.entityId,
      code: condition.code,
      hostId,
    }),
  };
}
