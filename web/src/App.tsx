import { useEffect, useState } from "react";

interface SummaryResponse {
  healthStatus: "healthy" | "attention" | "critical" | "unknown";
  healthScore: number;
  reasons: string[];
  hostCount: number;
  containerCounts: {
    running: number;
    unhealthy: number;
    restarting: number;
    stopped: number;
    unknown: number;
  };
}

interface ContainerSummary {
  dockerId: string;
  name: string;
  image: string;
  state: string;
  health: string;
  composeProject: string | null;
  composeService: string | null;
  restartCount: number;
  critical: boolean;
}

interface ContainerEvent {
  id: number;
  occurredAt: string;
  type: string;
  severity: string;
  summary: string;
}

interface ContainerDetail {
  container: ContainerSummary;
  events: ContainerEvent[];
}

interface AttentionItem {
  id: number;
  entityType: string;
  entityId: string;
  code: string;
  severity: string;
  penalty: number;
  summary: string;
  detectedAt: string;
}

interface MetricPoint {
  observedAt: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}

interface MetricsResponse {
  range: string;
  resolution: "raw" | "hourly";
  points: MetricPoint[];
}

type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

function useJsonFetch<T>(url: string, deps: unknown[] = []): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json() as Promise<T>;
      })
      .then((data) => setState({ status: "ready", data }))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

function StateBadge({ state, health }: { state: string; health: string }): React.JSX.Element {
  const label = health !== "none" ? `${state} / ${health}` : state;
  const tone = health === "unhealthy" || state === "dead" ? "bad" : state === "running" ? "good" : "neutral";
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

function SeverityBadge({ severity }: { severity: string }): React.JSX.Element {
  const tone = severity === "critical" ? "bad" : severity === "warning" ? "neutral" : "good";
  return <span className={`badge badge-${tone}`}>{severity}</span>;
}

// Minimal inline SVG sparkline -- deliberately not a full charting library (per the UX spec's
// "avoid decorative charts; prefer a number, threshold, and trend"). Just enough to show a
// trend at a glance next to the actual current numbers, which are always shown alongside it.
function Sparkline({ points }: { points: number[] }): React.JSX.Element | null {
  if (points.length < 2) return null;
  const width = 200;
  const height = 32;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });
  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label="Trend">
      <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function ContainerMetricsPanel({ id }: { id: string }): React.JSX.Element {
  const metrics = useJsonFetch<MetricsResponse>(`/api/v1/containers/${id}/metrics?range=24h`, [id]);

  if (metrics.status === "loading") return <p className="tagline">Loading metrics…</p>;
  if (metrics.status === "error") return <p className="error">Could not load metrics: {metrics.message}</p>;
  if (metrics.data.points.length === 0) return <p className="tagline">No metrics collected yet for this range.</p>;

  const latest = metrics.data.points[metrics.data.points.length - 1];
  const cpuSeries = metrics.data.points.map((p) => p.cpuPercent).filter((v): v is number => v !== null);
  const memPercentSeries = metrics.data.points
    .filter((p) => p.memoryBytes !== null && p.memoryLimitBytes !== null && p.memoryLimitBytes > 0)
    .map((p) => ((p.memoryBytes as number) / (p.memoryLimitBytes as number)) * 100);

  return (
    <div className="metrics-panel">
      <div className="metric-tile">
        <span className="metric-label">CPU</span>
        <span className="metric-value">{latest?.cpuPercent !== null && latest?.cpuPercent !== undefined ? `${latest.cpuPercent.toFixed(1)}%` : "—"}</span>
        <Sparkline points={cpuSeries} />
      </div>
      <div className="metric-tile">
        <span className="metric-label">Memory</span>
        <span className="metric-value">
          {latest?.memoryBytes !== null && latest?.memoryLimitBytes !== null && latest !== undefined
            ? `${(((latest.memoryBytes as number) / (latest.memoryLimitBytes as number)) * 100).toFixed(1)}%`
            : "—"}
        </span>
        <Sparkline points={memPercentSeries} />
      </div>
    </div>
  );
}

function ContainerDetailPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const state = useJsonFetch<ContainerDetail>(`/api/v1/containers/${id}`, [id]);
  const [saving, setSaving] = useState(false);

  async function toggleCritical(current: boolean): Promise<void> {
    setSaving(true);
    try {
      await fetch(`/api/v1/containers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ critical: !current }),
      });
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="detail-panel">
      <button type="button" onClick={onClose} className="close-btn">
        Close
      </button>
      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "error" && <p className="error">Could not load container: {state.message}</p>}
      {state.status === "ready" && (
        <>
          <h2>{state.data.container.name}</h2>
          <p className="tagline">{state.data.container.image}</p>
          <p>
            <StateBadge state={state.data.container.state} health={state.data.container.health} /> · restarts:{" "}
            {state.data.container.restartCount}
          </p>
          <p>
            <button type="button" className="critical-toggle" disabled={saving} onClick={() => void toggleCritical(state.data.container.critical)}>
              {state.data.container.critical ? "★ Critical (click to unmark)" : "☆ Mark as critical"}
            </button>
          </p>

          <h3>Metrics (last 24h)</h3>
          <ContainerMetricsPanel id={id} />

          <h3>Recent events</h3>
          {state.data.events.length === 0 && <p className="tagline">No events recorded yet.</p>}
          <ul className="event-list">
            {state.data.events.map((event) => (
              <li key={event.id}>
                <span className="event-time">{event.occurredAt}</span> <strong>{event.type}</strong> — {event.summary}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AttentionQueue({ onSelect }: { onSelect: (containerId: string) => void }): React.JSX.Element | null {
  const attention = useJsonFetch<{ items: AttentionItem[] }>("/api/v1/attention");

  if (attention.status !== "ready" || attention.data.items.length === 0) return null;

  return (
    <section className="attention-queue">
      <h2>Attention queue</h2>
      <ul className="event-list">
        {attention.data.items.map((item) => (
          <li key={item.id}>
            <SeverityBadge severity={item.severity} /> {item.summary}
            {item.entityType === "container" && (
              <>
                {" "}
                —{" "}
                <button type="button" className="link-btn" onClick={() => onSelect(item.entityId)}>
                  view container
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const summary = useJsonFetch<SummaryResponse>("/api/v1/summary", [refreshKey]);
  const containersState = useJsonFetch<{ containers: ContainerSummary[] }>("/api/v1/containers", [refreshKey]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function refresh(): void {
    setRefreshKey((k) => k + 1);
  }

  return (
    <main className="shell">
      <h1>KangDocker</h1>
      <p className="tagline">Local-first Docker observability — Milestone 3: health scoring and history.</p>

      {summary.status === "loading" && <p>Loading summary…</p>}
      {summary.status === "error" && <p className="error">Could not reach the API: {summary.message}</p>}
      {summary.status === "ready" && (
        <section className="summary-card">
          <p>
            Status: <strong>{summary.data.healthStatus}</strong> ({summary.data.healthScore}/100) · {summary.data.hostCount} host(s)
          </p>
          <ul>
            {summary.data.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="counts-row">
            <span>Running: {summary.data.containerCounts.running}</span>
            <span>Unhealthy: {summary.data.containerCounts.unhealthy}</span>
            <span>Restarting: {summary.data.containerCounts.restarting}</span>
            <span>Stopped: {summary.data.containerCounts.stopped}</span>
            <span>Unknown: {summary.data.containerCounts.unknown}</span>
          </div>
        </section>
      )}

      <AttentionQueue onSelect={setSelectedId} />

      <h2>Containers</h2>
      {containersState.status === "loading" && <p>Loading containers…</p>}
      {containersState.status === "error" && <p className="error">Could not reach the API: {containersState.message}</p>}
      {containersState.status === "ready" && containersState.data.containers.length === 0 && (
        <p className="tagline">No containers observed yet — the collector may still be on its first cycle.</p>
      )}
      {containersState.status === "ready" && containersState.data.containers.length > 0 && (
        <div className="container-table" role="table">
          {containersState.data.containers.map((container) => (
            <button
              type="button"
              key={container.dockerId}
              className="container-row"
              role="row"
              onClick={() => setSelectedId(container.dockerId)}
            >
              <span className="container-name">
                {container.critical && <span title="Marked critical">★ </span>}
                {container.name}
              </span>
              <span className="container-project">{container.composeProject ?? "—"}</span>
              <StateBadge state={container.state} health={container.health} />
            </button>
          ))}
        </div>
      )}

      {selectedId && <ContainerDetailPanel id={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} />}
    </main>
  );
}
