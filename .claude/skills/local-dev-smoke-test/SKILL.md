---
name: local-dev-smoke-test
description: Run CraftPanel locally with Docker Compose and smoke-test the API with curl (login, config, create/stop/delete a server). Use to verify any backend or frontend change, since the project has no automated tests.
---

# Local run + smoke test

## Prereqs
- Docker must be running. On Windows that means starting Docker Desktop (the engine pipe is
  `dockerDesktopLinuxEngine`). Check with `docker version`.
- Don't run `node panel/server.js` on the host: it hardcodes `/var/run/docker.sock`. Use compose.

## Start
```bash
[ -f .env ] || cp .env.example .env
# edit .env: ADMIN_PASSWORD=<8+ chars, not change-me-please>, PUBLIC_HOST=localhost
docker compose up -d --build
docker compose logs --tail 20 panel     # expect "Minecraft panel running on :8080"
```
If the panel exits immediately, the log says `ERROR: set a strong ADMIN_PASSWORD`.

## Smoke test (bash)
```bash
B=http://localhost:8080; J=/tmp/cp.cookies   # on Windows use a scratchpad path for the cookie jar
PASS=$(grep ^ADMIN_PASSWORD= .env | cut -d= -f2-)
curl -s -o /dev/null -w '%{http_code}\n' $B/api/servers                    # 401
curl -s -c $J -H 'Content-Type: application/json' -d "{\"password\":\"$PASS\"}" $B/api/login   # {"ok":true}
curl -s -b $J $B/api/config | head -c 200; echo
curl -s -b $J -H 'Content-Type: application/json' -d '{"name":"smoke","memory":"1G"}' $B/api/servers
curl -s -b $J $B/api/servers                                               # state running, health starting→healthy
curl -s -b $J "$B/api/servers/smoke/logs?tail=20"
# after health=healthy (1–3 min):
curl -s -b $J -H 'Content-Type: application/json' -d '{"command":"list"}' $B/api/servers/smoke/command
curl -s -b $J -X POST $B/api/servers/smoke/stop
curl -s -b $J -X DELETE "$B/api/servers/smoke?deleteWorld=1"               # clean up
```
Validation checks worth running after touching `sanitize()`: send a bad enum, an out-of-range int, or
a bad player name, and expect a 400 with a clear `error`.

## UI check
Open http://localhost:8080, log in, and check the change in the browser (the `run` skill or Claude in
Chrome can drive it). Watch the devtools console for errors.

## Cleanup
Always delete test servers with `deleteWorld=1`, and `docker compose down` when done if the user doesn't
want it left running. Never delete servers or volumes you didn't create in this session.
