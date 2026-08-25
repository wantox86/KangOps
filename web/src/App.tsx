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

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SummaryResponse };

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/v1/summary", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json() as Promise<SummaryResponse>;
      })
      .then((data) => setState({ status: "ready", data }))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <h1>KangDocker</h1>
      <p className="tagline">Local-first Docker observability — Milestone 1 foundation.</p>

      {state.status === "loading" && <p>Loading summary…</p>}

      {state.status === "error" && (
        <p className="error">Could not reach the API: {state.message}</p>
      )}

      {state.status === "ready" && (
        <section className="summary-card">
          <p>
            Status: <strong>{state.data.healthStatus}</strong> ({state.data.healthScore}/100)
          </p>
          <ul>
            {state.data.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
