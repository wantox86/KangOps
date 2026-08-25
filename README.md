# KangDocker

Local-first Docker observability and control tower for a homelab. Not a Portainer clone —
prioritizes understanding ("is my homelab healthy, and why") over full Docker administration.

**Status: Milestone 1 (Runnable foundation) complete.** No Docker collection yet — that's
Milestone 2. Right now this is the skeleton: a working API + web shell + persistent storage +
Compose deployment, with an `/api/v1/summary` endpoint that returns honest placeholder data.

See [`CLAUDE.md`](./CLAUDE.md) for the full product spec, architecture, and roadmap.

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22 + TypeScript (strict) + Fastify |
| Web | React + Vite + TypeScript |
| Storage | SQLite (`better-sqlite3` + Drizzle ORM), WAL mode |
| Deployment | Docker Compose, two services (`api`, `web`) |

## Local development

```bash
cp .env.example .env

cd api && npm install && npm run dev    # http://localhost:3001
cd web && npm install && npm run dev    # http://localhost:5173 (proxies /api to :3001)
```

## Running via Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:8085/api/v1/summary
```

Web UI: `http://localhost:8085` (port 8085 by default, not 8080 — see `docker-compose.yml`'s
comment on why). Override with `WEB_PORT` in `.env`.

## Checks

```bash
# from api/ or web/
npm run lint
npm run typecheck
npm test      # api only for now; web has no test suite yet (Milestone 1 has no logic to test there)
npm run build
```

## License

MIT.
