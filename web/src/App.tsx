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

function ContainerDetailPanel({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const state = useJsonFetch<ContainerDetail>(`/api/v1/containers/${id}`, [id]);

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

export function App(): React.JSX.Element {
  const summary = useJsonFetch<SummaryResponse>("/api/v1/summary");
  const containersState = useJsonFetch<{ containers: ContainerSummary[] }>("/api/v1/containers");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <main className="shell">
      <h1>KangDocker</h1>
      <p className="tagline">Local-first Docker observability — Milestone 2: read-only collection and visibility.</p>

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
              <span className="container-name">{container.name}</span>
              <span className="container-project">{container.composeProject ?? "—"}</span>
              <StateBadge state={container.state} health={container.health} />
            </button>
          ))}
        </div>
      )}

      {selectedId && <ContainerDetailPanel id={selectedId} onClose={() => setSelectedId(null)} />}
    </main>
  );
}
