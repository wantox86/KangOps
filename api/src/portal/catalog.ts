// Static, versioned catalog of every homelab service -- Docker containers AND native
// services (launchd/systemd) across MACMINI / BMAX / HPMINI. Deliberately a checked-in
// source file rather than DB rows or Docker introspection:
//
//   - Docker introspection can't see native services (9router, filebrowser, cloudflared…)
//     and can't know which published port is the "front door" worth linking.
//   - A curated catalog is honest about status ("dead" entries stay listed with a flag
//     instead of silently vanishing) and about exposure (public via Cloudflare tunnel vs
//     LAN-only) -- neither is discoverable from the Docker API.
//
// MAINTENANCE: when the homelab changes (new service, new tunnel hostname, service
// retired), update this file in the same PR/commit. It's the portal's source of truth.

export type PortalExposure = "public" | "lan";
export type PortalRuntime = "docker" | "native";
export type PortalStatus = "live" | "dead";

export interface PortalEntry {
  name: string;
  description: string;
  host: "macmini" | "bmax" | "hpmini";
  runtime: PortalRuntime;
  exposure: PortalExposure;
  status: PortalStatus;
  /** Primary URL to open. Optional -- some services (SMB, RustDesk relays) have no web UI. */
  url?: string;
  /** Direct LAN address when the primary URL goes through the Cloudflare tunnel. */
  lanUrl?: string;
}

export const PORTAL_CATALOG: PortalEntry[] = [
  // ── Public (Cloudflare tunnel, quezacolt.my.id) ─────────────────────────────
  {
    name: "History Tracking (WebBeacon)",
    description: "Travel/history tracking app — full stack (frontend, backend, PostGIS, OSRM).",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://ht.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:80",
  },
  {
    name: "Monthly Journal",
    description: "Monthly journaling app (Vue frontend + FastAPI backend + MySQL).",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://journal.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:8080",
  },
  {
    name: "Copilot Chat History",
    description: "Web UI to browse/search Copilot conversation exports (JWT auth, 3 users).",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://copilot-chat-history.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:8083",
  },
  {
    name: "signPDF Backend",
    description: "PDF signing service (Go + MySQL, custom Basic-style auth).",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://signpdf-backend.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:8090",
  },
  {
    name: "VeilKeepers (sprint 3)",
    description: "Password vault backend — current generation, target of the Android app.",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://veilkeepers.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:18080",
  },
  {
    name: "VeilKeeper (legacy)",
    description: "First-generation vault API. Superseded by sprint 3; kept for reference.",
    host: "macmini",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://veilkeeper.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:18091",
  },
  {
    name: "Immich",
    description: "Self-hosted photo/video backup (ML disabled). Storage on BMAX local disk.",
    host: "bmax",
    runtime: "docker",
    exposure: "public",
    status: "live",
    url: "https://immich.quezacolt.my.id",
    lanUrl: "http://192.168.50.163:2283",
  },
  {
    name: "File Browser",
    description: "File manager for HPMINI storage (served over the tunnel from MACMINI).",
    host: "hpmini",
    runtime: "native",
    exposure: "public",
    status: "live",
    url: "https://files.quezacolt.my.id",
    lanUrl: "http://192.168.50.90:8181",
  },
  {
    name: "OpenClaw Gateway",
    description: "Vilo's gateway (Telegram bridge, browser control).",
    host: "macmini",
    runtime: "native",
    exposure: "public",
    status: "live",
    url: "https://openclaw.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:18789",
  },
  {
    name: "Ollama",
    description: "Local LLM runtime — installed but stopped; tunnel hostname still registered.",
    host: "macmini",
    runtime: "native",
    exposure: "public",
    status: "dead",
    url: "https://server.quezacolt.my.id",
    lanUrl: "http://192.168.50.131:11434",
  },

  // ── LAN only — MACMINI ──────────────────────────────────────────────────────
  {
    name: "KangOps",
    description: "This dashboard — Docker observability for the homelab. No auth yet: LAN only by design.",
    host: "macmini",
    runtime: "docker",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:8085",
  },
  {
    name: "9Router",
    description: "AI model router (launchd com.9router). Runs from the Homebrew npm copy.",
    host: "macmini",
    runtime: "native",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:20128",
  },
  {
    name: "TranslateIdBot",
    description: "Translation bot web service.",
    host: "macmini",
    runtime: "docker",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:8081",
  },
  {
    name: "VeilKeeper Web (legacy UI)",
    description: "Legacy vault frontend, paired with veilkeeper-api :18091. Not tunneled.",
    host: "macmini",
    runtime: "docker",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:18092",
  },
  {
    name: "Chromium (LinuxServer)",
    description: "Containerized Chromium with KasmVNC web UI (HTTP :3000, HTTPS :3010).",
    host: "macmini",
    runtime: "docker",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:3000",
  },
  {
    name: "Brave (LinuxServer)",
    description: "Containerized Brave with KasmVNC web UI (HTTP :3001, HTTPS :3011).",
    host: "macmini",
    runtime: "docker",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.131:3001",
  },

  // ── LAN only — BMAX ─────────────────────────────────────────────────────────
  {
    name: "RustDesk Server",
    description: "Self-hosted remote desktop (hbbs/hbbr), LAN only. Ports 21115–21119, no web UI.",
    host: "bmax",
    runtime: "docker",
    exposure: "lan",
    status: "live",
  },
  {
    name: "KangOps Agent (BMAX)",
    description: "Reports BMAX container/host state to KangOps. No UI.",
    host: "bmax",
    runtime: "native",
    exposure: "lan",
    status: "live",
  },

  // ── LAN only — HPMINI ───────────────────────────────────────────────────────
  {
    name: "File Browser (direct)",
    description: "Native filebrowser.service on HPMINI — same app as files.quezacolt.my.id.",
    host: "hpmini",
    runtime: "native",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.90:8181",
  },
  {
    name: "SMB Share",
    description: "Samba file share (smbd). Mount with smb://192.168.50.90.",
    host: "hpmini",
    runtime: "native",
    exposure: "lan",
    status: "live",
    url: "smb://192.168.50.90",
  },
  {
    name: "Apache2 (default)",
    description: "Stock Apache2 install on HPMINI — default page, nothing deployed on it.",
    host: "hpmini",
    runtime: "native",
    exposure: "lan",
    status: "live",
    url: "http://192.168.50.90:80",
  },
];

export interface PortalGroup {
  id: string;
  title: string;
  entries: PortalEntry[];
}

// Fixed display order: public first (that's what people bookmark), then LAN grouped by host.
const GROUPS: Array<{ id: string; title: string; match: (e: PortalEntry) => boolean }> = [
  { id: "public", title: "Public — Cloudflare Tunnel (quezacolt.my.id)", match: (e) => e.exposure === "public" },
  { id: "lan-macmini", title: "LAN — MACMINI (192.168.50.131)", match: (e) => e.exposure === "lan" && e.host === "macmini" },
  { id: "lan-bmax", title: "LAN — BMAX (192.168.50.163)", match: (e) => e.exposure === "lan" && e.host === "bmax" },
  { id: "lan-hpmini", title: "LAN — HPMINI (192.168.50.90)", match: (e) => e.exposure === "lan" && e.host === "hpmini" },
];

export function buildPortalGroups(): PortalGroup[] {
  return GROUPS.map((g) => ({ id: g.id, title: g.title, entries: PORTAL_CATALOG.filter(g.match) })).filter(
    (g) => g.entries.length > 0,
  );
}
