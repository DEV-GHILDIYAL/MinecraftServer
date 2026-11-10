# AI agents (CraftPanel)

Docker image that lets LLM agents play on a CraftPanel Minecraft server as normal survival players.
It wraps [minecraft-agent-harness](https://github.com/yc-software/minecraft-agent-harness) (MIT), pinned to commit
`775d558` in the `Dockerfile`, with its Minecraft libraries upgraded to 26.1 (`harness/`). The panel creates one container `mc-<server>-ai` per server from this image. You never run
it by hand.

```
panel ──docker──► mc-<server>-ai  (this image)
                    runner.mjs ── rate-limit gate (127.0.0.1) ◄── throttle.mjs in every agent process
                      └─ harness team: Aarav, Meera, Kabir ──mineflayer──► host.docker.internal:<server port>
                    volume mc-<server>-ai-state:/data   (sessions, notes, DMs, gate.json)
```

## Build

On the EC2 host, from the repo root:

```bash
docker compose --profile ai build ai-agents
```

Rebuild after changing anything in this folder or bumping `HARNESS_REF`.

## Files

| File | Role |
|---|---|
| `Dockerfile` | `node:22-bookworm`, clones the harness at a pinned commit, `npm ci --omit=dev` |
| `runner.mjs` | Entry point. Starts the gate, writes `team.json` / `agent.json` from `AI_CONFIG`, runs the harness, prints DMs as `[dm] A → B: text` |
| `throttle.mjs` | Preloaded via `NODE_OPTIONS=--import`. Wraps `fetch` for model API hosts so every request waits for a slot from the gate. A 429 is retried after the pause and is never handed to the harness, which would treat Gemini's "quota/billing" message as fatal and quit |

## Inputs (env set by the panel)

- `AI_CONFIG`: JSON `{host, port, mcVersion, model, thinking, rpm, dailyCap, objective, agents:[{name, personality}]}`.
  `{peers}` in the objective is replaced with the other agents' names.
- The provider key: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, ...

## Safety

The harness is configured so agents:
- join as **offline-mode survival players**, so they're never OP, and the harness refuses slash commands from survival agents
- get **no shell** (`sandbox: none`, `sharedMachine: none`). They coordinate through DMs and private notes
- run in a container with no docker.sock, all capabilities dropped, no-new-privileges, and memory/CPU/PID limits

The panel takes a world backup before agents start. The world rules in the objective (no griefing, build ≥150 blocks
from spawn, no TNT/lava/fire near builds) are instructions to the model, **not enforced**. Backups are the safety net.

## Limits

- Minecraft **26.1.x** only (protocol 775). The pinned harness is upgraded to mineflayer 4.39 in `harness/`, which
  explains every change. The panel refuses other versions, including `LATEST`.

## Live test (no API key needed)

`test/fake-model.mjs` is a scripted OpenAI-compatible "model" that drives the real harness through crafting, mining,
placing, eating, chests, pathfinding and DMs. Run it against a healthy CraftPanel server:

```bash
docker compose --profile ai build ai-agents
# protocol-level regression test (no server needed)
docker run --rm --entrypoint node -v "$PWD/ai-agents/test:/t:ro" craftpanel-ai-agents:latest --test /t/velocity.test.mjs
# live test: ONLY against a throwaway server (flat world, Easy). It turns mob spawning off and gives items
bash ai-agents/test/run-live-test.sh mc-<server> <host port> 26.1 240
```
- The gate applies to all agents together because they share one API key. Daily quotas reset at midnight Pacific time.

## Local test without Minecraft or a real API key

`HARNESS_BIN=<script>` makes the runner start that script instead of the harness, so the gate, throttle and DM feed can
be tested with a fake fetch preloaded before `throttle.mjs`.
