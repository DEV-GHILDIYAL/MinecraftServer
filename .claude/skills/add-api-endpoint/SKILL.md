---
name: add-api-endpoint
description: Add a new REST or SSE route to the CraftPanel Express backend (panel/server.js) and call it from the frontend, following the project's auth, locking and error-handling patterns. Use when adding any backend feature such as backups, file listing, plugin install, or a new server action.
---

# Add an API endpoint

## Placement (security critical)
`panel/server.js` order matters:
1. `/api/login`, `/api/logout`, `/api/me`: public
2. `app.use('/api', authGuard)`: **everything below is authenticated**
3. the other routes
4. `express.static(...)` last

Put new routes in the `// ---------- API ----------` section, **after** the guard. Never add a public
route unless the user explicitly wants one. Remember the panel effectively has root on the host.

## Handler patterns
- Read-only or non-mutating per-server route: `app.get('/api/servers/:name/x', wrap(async (req, res) => { const s = servers[req.params.name]; if (!s) return res.status(404).json({ error: 'Server not found' }); ... }))`
- Mutating per-server route (changes the container or registry): use `withServer(async (s, req, res) => ...)`,
  which handles the 404 and the per-server `busy` lock (409 when busy).
- Bad input → `throw new BadRequest('message')` (400). Unexpected errors bubble up to `wrap` (500).
- Validate every input explicitly (regex / range / enum). Reuse `NAME_RE`, `PLAYER_RE` and `clean()`.
- Docker calls: use `docker.getContainer(cname(name))` and `inspect(name)` (returns `null` on 404).
  Pass argv arrays to `exec`. **Never** build a `sh -c` string from user input.
- File paths inside the volume: never join user input into a path without rejecting `..`, absolute
  paths and NUL bytes.
- Change the registry only through `servers[name] = ...; saveServers(servers);`.
- SSE: copy the `/logs/stream` pattern (headers incl. `X-Accel-Buffering: no`, a 20s `: ping`, and
  cleanup on `req.on('close')`).

## Frontend
- Call it with `api('/api/...', { method, body })`. It throws `Error(data.error)` and handles 401.
- Show results with `toast(msg)` / `toast(msg, true)` for errors. User-facing copy is Hinglish.
- Disable the triggering button and show `el('span', { class: 'spin' })` while the request runs (see `openCreate`).
- Build DOM with `el()`. Don't use `innerHTML` with data.

## Then
- Add the route to the API table in `CLAUDE.md`.
- `node --check panel/server.js`, then the `local-dev-smoke-test` skill. Check that the route returns
  401 without the cookie: `curl -i localhost:8080/api/<route>`.
- For anything touching auth, docker exec, or the filesystem, run the `panel-security-reviewer` agent on the diff.
