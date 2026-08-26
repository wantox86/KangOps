// Pure function, fixture-tested in tests/alertCooldown.test.ts -- kept separate from
// notifier.ts's DB/network orchestration per CLAUDE.md's "put business rules behind pure
// functions" convention (mirrors health/reconcile.ts, metrics/retention.ts).
export function shouldSendAlert(lastSentAtIso: string | null, nowIso: string, cooldownMinutes: number): boolean {
  if (!lastSentAtIso) return true;
  const elapsedMs = new Date(nowIso).getTime() - new Date(lastSentAtIso).getTime();
  return elapsedMs >= cooldownMinutes * 60_000;
}
