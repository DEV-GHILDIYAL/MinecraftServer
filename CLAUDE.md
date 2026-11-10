# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

**CraftPanel**: a self-hosted web panel that creates and manages Minecraft Java servers on one AWS EC2 box.
Docker Compose runs only the panel. Each Minecraft server is a separate Docker container
(`itzg/minecraft-server`) that the panel creates through the host's Docker socket.

```
Browser ──HTTP──► panel (Express, :8080, container "mc-panel")
                    │  /var/run/docker.sock (dockerode)
                    ▼
                  mc-<name> containers  (host port 25565..25575 → container 25565)
                    └─ volume mc-<name>-data:/data   (world + server config)
                  panel-data volume → /app/data/servers.json  (registry of servers)
```

There's no build step, no framework, no database, no tests. Everything is plain JS.

## Files

| Path | Role |
|---|---|
| `panel/server.js` | The whole backend: auth, validation, Docker orchestration, REST + SSE API (~400 lines) |
| `panel/public/app.js` | The whole frontend: vanilla JS SPA, `el()` DOM builder, polling + EventSource |
| `panel/public/index.html` | Shell: login view, app view (topbar/sidebar/main), modal, toasts |
| `panel/public/style.css` | Minecraft-themed dark UI; colour tokens on `:root` |
| `panel/Dockerfile` | `node:20-alpine`, `npm install --omit=dev`, `node server.js` |
| `docker-compose.yml` | Panel service only; mounts docker.sock + `panel-data` volume |
| `ai-agents/` | Docker image for LLM agents (minecraft-agent-harness pinned + rate-limit gate). See `ai-agents/README.md` |
| `setup.sh` | One-time EC2 bootstrap: Docker, 2G swap, `.env` generation, ufw, image pre-pull, `compose up` |
| `.env.example` | `ADMIN_PASSWORD`, `SESSION_SECRET`, `PUBLIC_HOST`, `PANEL_PORT`, `MC_PORT_START/END`, `TZ`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP` |

## Backend (`panel/server.js`) mental model

- **Registry**: `servers` is an in-memory object `{ [name]: settings }`, loaded from and saved to
  `data/servers.json` with an atomic tmp+rename write (`saveServers`). The registry is the source of
  truth for settings. Containers are disposable and get rebuilt from it.
- **Settings → container**: `sanitize(input, base)` validates and merges against `DEFAULTS`/`ENUMS`.
  `buildEnv(s)` maps the settings to itzg env vars. `createContainer(s)` picks the image tag via
  `imageFor(version)` (java8 for <1.17, java17 for <1.20.5, otherwise latest), pulls it if missing,
  and creates it with `RestartPolicy: unless-stopped`.
- **Changing settings = recreate**: `PUT /api/servers/:name` stops and removes the container, saves
  the registry, then creates a new container. If the server was stopped before, it stops it again.
  The world survives because it lives in the named volume.
- **Commands** go through `rcon(name, cmd)` = `docker exec rcon-cli <cmd>` (argv, no shell).
  Player counts come from running `list` over RCON in `status()`. That happens on every
  `GET /api/servers` for healthy servers (the UI polls every 4s), which is why the console has a
  "Hide RCON noise" filter.
- **Concurrency**: `withServer()` takes a per-server lock (`busy` Set). A second action returns 409.
  Read-only routes (logs, stats, command) use plain `wrap()` without the lock.
- **Errors**: throw `new BadRequest(msg)` → 400 with `{error}`. Anything else → 500 with `e.message`.
  Always wrap async handlers with `wrap()` or `withServer()`.
- **Auth**: one shared `ADMIN_PASSWORD`. The cookie `session=<exp>.<hmac>` is stateless, HMAC-SHA256
  with `SESSION_SECRET`, and lasts 7 days. Cookie flags: HttpOnly, SameSite=Strict. After 10 failed
  logins an IP is locked out for 10 min (in-memory map). `/api/login`, `/api/logout` and `/api/me`
  are registered **before** the `app.use('/api', ...)` auth guard. Every route after it is protected.
  Static files are served last.
- The panel exits on startup if `ADMIN_PASSWORD` is shorter than 8 characters or still equals
  `change-me-please`.

### API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/login` `{password}` | sets cookie |
| POST | `/api/logout` | |
| GET | `/api/me` | `{loggedIn}` (public) |
| GET | `/api/config` | publicHost, port range, `DEFAULTS`, `ENUMS` (the frontend builds its form from these) |
| GET | `/api/servers` | array of `status(s)`: settings + `state`, `health`, `players`, `address`, `startedAt` |
| POST | `/api/servers` | create; `name` must match `^[a-z0-9][a-z0-9-]{0,30}$`; port is auto-assigned if omitted |
| PUT | `/api/servers/:name` | update settings (recreates the container) |
| POST | `/api/servers/:name/(start\|stop\|restart)` | recreates a missing container from the registry |
| DELETE | `/api/servers/:name?deleteWorld=1` | `deleteWorld=1` also removes the `mc-<name>-data` volume |
| GET | `/api/servers/:name/logs?tail=N` | one-shot logs (10–2000 lines) |
| GET | `/api/servers/:name/logs/stream` | SSE. Sends `event: reset` first, then `data: "<line>"`. Ends when the container stops; the client reconnects |
| GET | `/api/servers/:name/stats` | cpu %, cpuMax, mem bytes |
| GET | `/api/host` | host load / mem / disk / uptime |
| POST | `/api/servers/:name/command` `{command}` | RCON; strips a leading `/`, max 500 chars |
| POST | `/api/servers/:name/regenerate` `{seed, levelType}` | backup → delete world dirs + `level-seed` → recreate & start |
| GET | `/api/servers/:name/backups` | `{backups:[{file,reason,size,createdAt,hasSettings}], intervalHours, keep}` |
| POST | `/api/servers/:name/backups` | manual backup |
| POST | `/api/servers/:name/backups/:file/restore` `{restoreSettings}` | safety backup → wipe `/data` (keeps libraries/versions/cache) → untar |
| GET | `/api/servers/:name/backups/:file/download` | the .tgz file |
| DELETE | `/api/servers/:name/backups/:file` | |

| GET | `/api/servers/:name/ai` | `{config, wanted, hasKey, state, gate, problems, ...}` (the key is never returned) |
| PUT | `/api/servers/:name/ai` | save config (+ `apiKey`); restarts agents if they're running |
| POST | `/api/servers/:name/ai/start` \| `/ai/stop` | start runs `aiProblems()` checks → `backup(s,'ai')` → container |
| DELETE | `/api/servers/:name/ai/memory` | removes the `mc-<name>-ai-state` volume (agents must be stopped) |
| GET | `/api/servers/:name/ai/logs/stream` | SSE of the agent container's logs |

### AI agents (`ai-agents/`, see its README)
- One container per server: `mc-<name>-ai` from image `craftpanel-ai-agents:latest`, built with
  `docker compose --profile ai build ai-agents`. Agent memory lives in the volume `mc-<name>-ai-state`.
- Config is stored in `servers[name].ai` (`aiOf(s)` merges `AI_DEFAULTS`). The **API key is stored separately** in
  `data/ai-keys.json` (0600) so `status()`'s `...s` spread and the backup `.json` snapshots never contain it.
- `aiProblems()` gates every start: image built, key set, `aiProtocolFor(s.version)` is set (26.1 / 26.1.1 / 26.1.2,
  all protocol 775; `LATEST` is refused because it silently upgrades the world),
  `onlineMode` off, no agent name in `ops`, and server healthy. Never lower a server's version to make it pass,
  because downgrading a world can corrupt it.
- Lifecycle hooks: server stop → `removeAi`. Start/restart/settings save/restore/regenerate → `resumeAiWhenHealthy`
  (only if `ai.wanted`). Regenerate and delete also wipe the AI state volume. Delete also drops the key.
- Agents connect via `host.docker.internal:<s.port>` (`ExtraHosts: host-gateway`). Whitelisted servers get
  `whitelist add <agent>` over RCON at start.
- Safety model: offline survival players without OP. The harness blocks slash commands. `sandbox: none` and
  `sharedMachine: none` mean no shell. The container drops all caps and gets no docker.sock. The world rules in the
  objective are prompt-only. Rate limiting happens in `ai-agents/throttle.mjs` plus the runner gate, not in the harness.

### Backups
- Stored in the volume **`mc-backups`** (fixed name in compose), mounted in the panel at `/app/backups/<server>/`.
  Files are named `YYYY-MM-DD_HH-MM-SS_<reason>.tgz` (UTC), where reason is `auto|manual|settings|regenerate|restore`.
  A `.json` sidecar holds the settings snapshot. `BACKUP_RE` validates every name that comes from a URL.
- Tar, regenerate and restore run in **helper containers** (`runHelper`) that use the server's own itzg image,
  `NetworkMode: none`, label `mcpanel.helper=1`, and get removed afterwards. Leftovers are cleaned up when the panel starts.
- `backup()` sends `save-off` + `save-all flush` over RCON before tar when the server is healthy, and `save-on` after.
- `PUT` settings: if nothing changed it returns `{unchanged:true}`, with no backup and no restart. Otherwise
  `backup(s,'settings')` runs first, and a failed backup aborts the save.
- Scheduler: `autoBackupTick` runs every 10 min, 1 min after the panel starts. It backs up running servers whose newest backup
  is older than `BACKUP_INTERVAL_HOURS`, and skips if less than 2 GB is free. It takes the `busy` lock, so user actions get a 409 meanwhile.
- Retention: `BACKUP_KEEP` newest auto backups, plus `BACKUP_KEEP` of all the other kinds together.

## Frontend (`panel/public/app.js`) mental model

- No framework. Build every node with `el(tag, attrs, ...children)`: `on*` attrs become listeners,
  `class` and `style` are strings, and `false`/`null` children are skipped. **Never use `innerHTML`
  with server or user data.** The single `innerHTML` (in `drawSpark`) only takes numbers.
- `api(path, {method, body})` does the JSON fetch, shows the login view on 401, and throws `Error(data.error)`.
- A global `state` object. Timers: servers every 4s, host every 10s, stats every 3s, uptime every 1s.
- Routing is `#<server>/<tab>`, with tabs `overview | console | players | settings`.
- `renderMain()` rebuilds the whole view. `updateLive()` / `updateStats()` patch elements by id
  (`#hero-pill`, `#st-cpu`, ...) so polling doesn't wipe inputs. Keep that split: put periodic
  updates in `update*`, not in `render*`.
- The settings and create forms come from the `FIELDS` array. Select options come from
  `state.config.enums` (server-side `ENUMS`). `createOnly` fields (name, port) only appear in create.

## Conventions

- **UI copy is Hinglish** (Hindi in Latin script mixed with English), e.g. `'Koi server nahi. "+ New" dabao!'`.
  Match that tone in new user-facing strings. Code, comments and API errors are in English.
- Style: 2-space indent, single quotes, semicolons, `'use strict'`, compact one-line helpers.
  No dependencies beyond `express` + `dockerode` without a strong reason.
- CSS: use the tokens (`--grass`, `--diamond`, `--gold`, `--redstone`, `--lapis`, `--amethyst`,
  `--bg`, `--panel`, `--border`, `--text`, `--muted`, `--dim`). Buttons are
  `.mc-btn` + one of `green|red|gold|blue|ghost` and optionally `small|wide`. Containers are `.card` and `.card-title`.
- Docker naming is fixed and other things depend on it: container `mc-<name>`, volume `mc-<name>-data`,
  labels `mcpanel=1` and `mcpanel.name=<name>`. Don't rename these or existing servers become orphans.
- Express is **v4**. The route `/:action(start|stop|restart)` uses v4 regex-param syntax, which breaks on Express 5.

## Gotchas

- `onlineMode` defaults to `false` (cracked accounts allowed). With that, whitelist + few ops is the
  only identity protection. Don't flip the default silently.
- `seed` and `levelType` only take effect when a new world is generated. Changing them on an existing server does nothing.
- itzg applies env vars (`WHITELIST`, `OPS`, properties) when the container starts. Changes made in-game
  with `whitelist add` / `op` persist in the volume, but they don't show up in the panel's registry.
- Port assignment only checks the registry, not ports actually in use on the host.
- If `createContainer` fails during a PUT (for example an image pull error), the old container is already
  gone. The registry still holds the new settings, so **Start** recreates it.
- `failed` (login lockout map) is never pruned, and `req.socket.remoteAddress` is the proxy's IP if you put
  the panel behind a reverse proxy.
- The panel has docker.sock, which means **root on the host**. Treat any auth or injection bug as critical.

## Running / verifying

There's no test suite. Verify by running the stack (see the `local-dev-smoke-test` skill):

```bash
cp .env.example .env    # set ADMIN_PASSWORD (>=8 chars, not the default) and PUBLIC_HOST=localhost
docker compose up -d --build
docker compose logs -f panel
```

`node panel/server.js` directly on Windows won't work: the socket path `/var/run/docker.sock` is hardcoded.
Always run it via compose (Docker Desktop must be running).

Quick syntax check without Docker: `node --check panel/server.js && node --check panel/public/app.js`.

## Project skills & agents

- Skills (`.claude/skills/`): `add-server-setting`, `add-api-endpoint`, `local-dev-smoke-test`,
  `deploy-update`, `world-backup-restore`.
- Agents (`.claude/agents/`): `panel-security-reviewer` (review diffs for auth/injection/docker risks),
  `server-troubleshooter` (diagnose a server that won't start or that players can't join).
