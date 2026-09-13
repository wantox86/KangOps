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
  hostId: string;
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

// ---- Milestone 7: multi-host -------------------------------------------------------------

interface HostItem {
  id: string;
  name: string;
  status: string;
  kind: "local" | "agent";
  lastSeenAt: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  containerCount: number;
  agentVersion: string | null;
}

interface AgentItem {
  id: number;
  name: string;
  hostId: string;
  expectedIntervalSeconds: number;
  enabled: boolean;
  tokenMasked: string;
  agentVersion: string | null;
  lastReportAt: string | null;
  status: "pending" | "reporting" | "stale";
}

// Capacity is shown as a number with its threshold state, never as a decorative gauge -- same
// rule the rest of this dashboard follows ("prefer a number, threshold, and trend").
function CapacityCell({ label, percent }: { label: string; percent: number | null }): React.JSX.Element {
  if (percent === null) return <span className="capacity-cell">{label} —</span>;
  const tone = percent >= 90 ? "bad" : percent >= 80 ? "neutral" : "good";
  return (
    <span className="capacity-cell">
      {label} <span className={`badge badge-${tone}`}>{percent.toFixed(0)}%</span>
    </span>
  );
}

// Every tracked host in one place: the local collector's own host alongside every agent-reporting
// remote host. A host row states its own liveness, because the two kinds fail differently -- a
// local host can't go "stale", and an unreachable agent host can't be diagnosed from here.
function HostsPanel(): React.JSX.Element | null {
  const hosts = useJsonFetch<{ hosts: HostItem[] }>("/api/v1/hosts");

  if (hosts.status !== "ready" || hosts.data.hosts.length === 0) return null;

  return (
    <section className="hosts-panel">
      <h2>Hosts</h2>
      <div className="host-grid">
        {hosts.data.hosts.map((host) => (
          <div key={host.id} className="host-card">
            <p className="host-card-title">
              <strong>{host.name}</strong>{" "}
              <span className="badge badge-neutral">{host.kind === "agent" ? "agent" : "local"}</span>{" "}
              <span className={`badge badge-${host.status === "reachable" ? "good" : host.status === "unknown" ? "neutral" : "bad"}`}>
                {host.status}
              </span>
            </p>
            <div className="counts-row">
              <CapacityCell label="CPU" percent={host.cpuPercent} />
              <CapacityCell label="Memory" percent={host.memoryPercent} />
              <CapacityCell label="Disk" percent={host.diskPercent} />
            </div>
            <p className="tagline">
              {host.containerCount} container(s) · last seen {host.lastSeenAt}
              {host.agentVersion ? ` · agent v${host.agentVersion}` : ""}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentsPanel(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const agents = useJsonFetch<{ items: AgentItem[] }>("/api/v1/agents", [refreshKey]);
  const [name, setName] = useState("");
  const [expectedIntervalSeconds, setExpectedIntervalSeconds] = useState(30);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setCreateError(null);
    try {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expectedIntervalSeconds }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      const created = (await response.json()) as { token: string };
      setNewToken(created.token);
      setName("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function remove(id: number): Promise<void> {
    await fetch(`/api/v1/agents/${id}`, { method: "DELETE" });
    setRefreshKey((k) => k + 1);
  }

  return (
    <section className="ops-panel">
      <h3>Remote agents</h3>
      <p className="tagline">
        A registered host runs the agent from <code>agent/</code>, which pushes its own metrics here over an outbound
        connection — the monitored host opens no inbound port. An agent that misses 3 intervals opens an
        <code> agent_unreachable</code> condition.
      </p>

      {newToken && (
        <p className="token-callout">
          Agent registered. Token (shown once, copy it into the agent's <code>.env</code> now): <code>{newToken}</code>
          <button type="button" onClick={() => setNewToken(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="form-row">
        <input placeholder="host name (e.g. BMAX)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="number"
          min={5}
          max={3600}
          value={expectedIntervalSeconds}
          onChange={(e) => setExpectedIntervalSeconds(Number(e.target.value))}
          title="Expected report interval (seconds)"
        />
        <button type="button" disabled={!name} onClick={() => void create()}>
          Register agent
        </button>
      </div>
      {createError && <p className="error">{createError}</p>}

      {agents.status === "ready" && agents.data.items.length === 0 && (
        <p className="tagline">No remote agents registered — KangOps is only watching its own host.</p>
      )}
      {agents.status === "ready" && agents.data.items.length > 0 && (
        <ul className="event-list">
          {agents.data.items.map((agent) => (
            <li key={agent.id}>
              <span className={`badge badge-${agent.status === "reporting" ? "good" : agent.status === "pending" ? "neutral" : "bad"}`}>
                {agent.status}
              </span>{" "}
              <strong>{agent.name}</strong> ({agent.hostId}) — every {agent.expectedIntervalSeconds}s — token{" "}
              {agent.tokenMasked}
              {agent.lastReportAt ? ` — last report ${agent.lastReportAt}` : " — never reported"}{" "}
              <button type="button" className="link-btn" onClick={() => void remove(agent.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Milestone 4: notification + operational context -------------------------------------

interface WebhookConfigResponse {
  enabled: boolean;
  urlMasked: string | null;
  format: "generic" | "discord" | "ntfy";
  cooldownMinutes: number;
}

interface AlertRecord {
  id: number;
  code: string;
  severity: string;
  status: string;
  summary: string;
  sentAt: string;
  error: string | null;
}

function WebhookSettingsPanel(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const config = useJsonFetch<WebhookConfigResponse>("/api/v1/settings/webhook", [refreshKey]);
  const alertsState = useJsonFetch<{ items: AlertRecord[] }>("/api/v1/alerts", [refreshKey]);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<WebhookConfigResponse["format"]>("generic");
  const [cooldownMinutes, setCooldownMinutes] = useState(30);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (config.status === "ready") {
      setEnabled(config.data.enabled);
      setFormat(config.data.format);
      setCooldownMinutes(config.data.cooldownMinutes);
    }
  }, [config]);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/v1/settings/webhook", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, url, format, cooldownMinutes }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      setUrl("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ops-panel">
      <h3>Webhook alerts</h3>
      {config.status === "ready" && (
        <p className="tagline">
          Currently {config.data.enabled ? "enabled" : "disabled"}
          {config.data.urlMasked ? ` — ${config.data.urlMasked}` : ""}. Sends on newly-opened attention/critical conditions,
          cooldown {config.data.cooldownMinutes}m.
        </p>
      )}
      <div className="form-row">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <input type="url" placeholder="https://... (leave blank to keep current)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <select value={format} onChange={(e) => setFormat(e.target.value as WebhookConfigResponse["format"])}>
          <option value="generic">generic JSON</option>
          <option value="discord">Discord</option>
          <option value="ntfy">ntfy</option>
        </select>
        <input type="number" min={1} value={cooldownMinutes} onChange={(e) => setCooldownMinutes(Number(e.target.value))} title="Cooldown minutes" />
        <button type="button" disabled={saving} onClick={() => void save()}>
          Save
        </button>
      </div>
      {saveError && <p className="error">{saveError}</p>}
      <p className="tagline">
        Note: enabling with a blank URL only works if a URL was already saved before — this form never shows the saved URL back
        (it&apos;s treated as a secret).
      </p>

      <h4>Recent deliveries</h4>
      {alertsState.status === "ready" && alertsState.data.items.length === 0 && <p className="tagline">No alerts sent yet.</p>}
      {alertsState.status === "ready" && alertsState.data.items.length > 0 && (
        <ul className="event-list">
          {alertsState.data.items.map((a) => (
            <li key={a.id}>
              <SeverityBadge severity={a.severity} /> <span className={`badge badge-${a.status === "sent" ? "good" : "bad"}`}>{a.status}</span>{" "}
              {a.summary} {a.error ? `(${a.error})` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface BackupTargetItem {
  id: number;
  name: string;
  expectedFrequencyMinutes: number;
  checkPath: string | null;
  enabled: boolean;
  tokenMasked: string;
  lastSuccessAt: string | null;
  lastRunWasFailure: boolean;
}

function BackupTargetsPanel(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const targets = useJsonFetch<{ items: BackupTargetItem[] }>("/api/v1/backup-targets", [refreshKey]);
  const [name, setName] = useState("");
  const [expectedFrequencyMinutes, setExpectedFrequencyMinutes] = useState(1440);
  const [checkPath, setCheckPath] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setCreateError(null);
    try {
      const response = await fetch("/api/v1/backup-targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expectedFrequencyMinutes, checkPath: checkPath || null }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      const created = (await response.json()) as { token: string };
      setNewToken(created.token);
      setName("");
      setCheckPath("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function remove(id: number): Promise<void> {
    await fetch(`/api/v1/backup-targets/${id}`, { method: "DELETE" });
    setRefreshKey((k) => k + 1);
  }

  return (
    <section className="ops-panel">
      <h3>Backup targets</h3>
      <p className="tagline">
        Freshness is checked each collector cycle (filesystem mtime and/or reported webhook results); stale/failed/missing
        backups feed the health score just like any other condition.
      </p>

      {newToken && (
        <p className="token-callout">
          Target created. Auth token (shown once, copy it now): <code>{newToken}</code>
          <button type="button" onClick={() => setNewToken(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="form-row">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="number" min={1} value={expectedFrequencyMinutes} onChange={(e) => setExpectedFrequencyMinutes(Number(e.target.value))} title="Expected frequency (minutes)" />
        <input placeholder="filesystem check path (optional)" value={checkPath} onChange={(e) => setCheckPath(e.target.value)} />
        <button type="button" disabled={!name} onClick={() => void create()}>
          Add target
        </button>
      </div>
      {createError && <p className="error">{createError}</p>}

      {targets.status === "ready" && targets.data.items.length === 0 && <p className="tagline">No backup targets configured yet.</p>}
      {targets.status === "ready" && targets.data.items.length > 0 && (
        <ul className="event-list">
          {targets.data.items.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> — expected every {t.expectedFrequencyMinutes}m — token {t.tokenMasked} —{" "}
              {t.lastRunWasFailure ? (
                <span className="badge badge-bad">last run failed</span>
              ) : t.lastSuccessAt ? (
                `last success ${t.lastSuccessAt}`
              ) : (
                <span className="badge badge-neutral">no reports yet</span>
              )}{" "}
              <button type="button" className="link-btn" onClick={() => void remove(t.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ImageItem {
  dockerId: string;
  name: string;
  imageRef: string;
  currentDigest: string | null;
  registryChecked: boolean;
  registrySupported: boolean | null;
  latestDigest: string | null;
  updateAvailable: boolean | null;
  checkError: string | null;
}

function ImagesPanel(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const images = useJsonFetch<{ registryCheckEnabled: boolean; items: ImageItem[] }>("/api/v1/images", [refreshKey]);
  const [saving, setSaving] = useState(false);

  async function toggleRegistryChecks(next: boolean): Promise<void> {
    setSaving(true);
    try {
      await fetch("/api/v1/settings/registry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      setRefreshKey((k) => k + 1);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ops-panel">
      <h3>Images / update center</h3>
      <p className="tagline">
        Registry checks are opt-in and only query public, unauthenticated Docker Hub tags — never auto-connects to a registry.
        Non-Docker-Hub images always show as "not checked".
      </p>
      {images.status === "ready" && (
        <label>
          <input type="checkbox" disabled={saving} checked={images.data.registryCheckEnabled} onChange={(e) => void toggleRegistryChecks(e.target.checked)} />{" "}
          Enable Docker Hub registry checks
        </label>
      )}
      {images.status === "ready" && (
        <ul className="event-list">
          {images.data.items.map((i) => (
            <li key={i.dockerId}>
              <strong>{i.name}</strong> ({i.imageRef}) —{" "}
              {i.updateAvailable === true && <span className="badge badge-neutral">update available</span>}
              {i.updateAvailable === false && <span className="badge badge-good">up to date</span>}
              {i.updateAvailable === null && (i.registrySupported === false ? "not checked (unsupported registry)" : "not checked")}
              {i.checkError && <span className="tagline"> ({i.checkError})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DependencyGroup {
  composeProject: string;
  confidence: string;
  note: string;
  containerIds: string[];
}

interface DependencyAnnotationItem {
  id: number;
  fromContainerId: string;
  toContainerId: string;
  note: string | null;
  confidence: string;
}

function DependenciesPanel({ containers }: { containers: ContainerSummary[] }): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const view = useJsonFetch<{ groups: DependencyGroup[]; annotations: DependencyAnnotationItem[] }>("/api/v1/dependencies", [refreshKey]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [note, setNote] = useState("");

  function nameFor(id: string): string {
    return containers.find((c) => c.dockerId === id)?.name ?? id;
  }

  async function addAnnotation(): Promise<void> {
    if (!fromId || !toId) return;
    await fetch("/api/v1/dependencies/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromContainerId: fromId, toContainerId: toId, note: note || null }),
    });
    setNote("");
    setRefreshKey((k) => k + 1);
  }

  async function removeAnnotation(id: number): Promise<void> {
    await fetch(`/api/v1/dependencies/annotations/${id}`, { method: "DELETE" });
    setRefreshKey((k) => k + 1);
  }

  return (
    <section className="ops-panel">
      <h3>Dependencies</h3>
      <p className="tagline">
        Conservative by design: Compose-project grouping is labeled "weak" and never implies an actual runtime dependency;
        only explicitly declared annotations below are treated as a real relationship.
      </p>

      {view.status === "ready" && view.data.groups.length > 0 && (
        <ul className="event-list">
          {view.data.groups.map((g) => (
            <li key={g.composeProject}>
              <span className="badge badge-neutral">{g.confidence}</span> Compose project <strong>{g.composeProject}</strong>:{" "}
              {g.containerIds.map(nameFor).join(", ")} — <span className="tagline">{g.note}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="form-row">
        <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
          <option value="">from…</option>
          {containers.map((c) => (
            <option key={c.dockerId} value={c.dockerId}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={toId} onChange={(e) => setToId(e.target.value)}>
          <option value="">to…</option>
          {containers.map((c) => (
            <option key={c.dockerId} value={c.dockerId}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" disabled={!fromId || !toId} onClick={() => void addAnnotation()}>
          Add annotation
        </button>
      </div>

      {view.status === "ready" && view.data.annotations.length === 0 && <p className="tagline">No declared dependencies yet.</p>}
      {view.status === "ready" && view.data.annotations.length > 0 && (
        <ul className="event-list">
          {view.data.annotations.map((a) => (
            <li key={a.id}>
              <span className="badge badge-good">{a.confidence}</span> {nameFor(a.fromContainerId)} → {nameFor(a.toContainerId)}
              {a.note ? ` — ${a.note}` : ""}{" "}
              <button type="button" className="link-btn" onClick={() => void removeAnnotation(a.id)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OperationsSection({ containers }: { containers: ContainerSummary[] }): React.JSX.Element {
  return (
    <section className="operations-section">
      <h2>Operations</h2>
      <AgentsPanel />
      <WebhookSettingsPanel />
      <BackupTargetsPanel />
      <ImagesPanel />
      <DependenciesPanel containers={containers} />
    </section>
  );
}

export function App(): React.JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0);
  const summary = useJsonFetch<SummaryResponse>("/api/v1/summary", [refreshKey]);
  const containersState = useJsonFetch<{ containers: ContainerSummary[] }>("/api/v1/containers", [refreshKey]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The host column only earns its space once more than one host is being tracked -- on a
  // single-host install it would be a column of identical values.
  const containerRows = containersState.status === "ready" ? containersState.data.containers : [];
  const showHostColumn = new Set(containerRows.map((c) => c.hostId)).size > 1;

  function refresh(): void {
    setRefreshKey((k) => k + 1);
  }

  return (
    <main className="shell">
      <h1>KangOps</h1>
      <p className="tagline">Local-first Docker observability — Milestone 7: multi-host agents.</p>

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

      <HostsPanel />

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
              className={showHostColumn ? "container-row container-row-multihost" : "container-row"}
              role="row"
              onClick={() => setSelectedId(container.dockerId)}
            >
              <span className="container-name">
                {container.critical && <span title="Marked critical">★ </span>}
                {container.name}
              </span>
              {showHostColumn && <span className="container-host">{container.hostId}</span>}
              <span className="container-project">{container.composeProject ?? "—"}</span>
              <StateBadge state={container.state} health={container.health} />
            </button>
          ))}
        </div>
      )}

      {selectedId && <ContainerDetailPanel id={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} />}

      <OperationsSection containers={containersState.status === "ready" ? containersState.data.containers : []} />
    </main>
  );
}
