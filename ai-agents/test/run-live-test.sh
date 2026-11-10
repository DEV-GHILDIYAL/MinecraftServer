#!/usr/bin/env bash
# Live test of the AI agents image against a running CraftPanel Minecraft server, using the scripted fake model
# (no API key needed). Two agents join, get items over RCON, then walk through fake-model.mjs STEPS:
# craft, equip, gather, place, break, eat, chest deposit/withdraw, pathfind and DM each other.
#
#   bash ai-agents/test/run-live-test.sh <mc-container> <host-port> <protocol-version> [seconds]
#   e.g. bash ai-agents/test/run-live-test.sh mc-w261 25590 26.1 240
#
# Needs: the craftpanel-ai-agents:latest image and a healthy THROWAWAY test server (flat world, Easy, Premium accounts
# OFF). The script turns mob spawning off and gives items, so never run it against a world you care about.
# Output: fake-model.log (one JSON line per tool call/result) and agents.log in ai-agents/test/out/.
set -euo pipefail
MC=${1:?mc container}; PORT=${2:?host port}; VER=${3:?protocol version e.g. 26.1}; SECS=${4:-240}
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"; rm -rf "$OUT"; mkdir -p "$OUT"
MNT="$HERE"
if command -v cygpath >/dev/null 2>&1; then MNT="$(cygpath -w "$HERE")"; export MSYS_NO_PATHCONV=1; fi # Git Bash on Windows
AGENTS=(Tester1 Tester2)
cleanup() { docker rm -f mcai-fake-model mcai-live-test >/dev/null 2>&1 || true; docker volume rm mcai-live-test-state >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

START=$(date -u +%Y-%m-%dT%H:%M:%SZ) # only look at server log lines from this run
docker exec "$MC" rcon-cli "time set day" >/dev/null
# No mobs, so nothing interrupts the scripted actions or kills the agents (this tests the protocol and tools, not
# combat). NOTE: this turns mob spawning off on the server, so only point this script at a throwaway test server.
docker exec "$MC" rcon-cli "gamerule spawn_mobs false" >/dev/null 2>&1 || true  # 1.21.11+ / 26.x name
docker exec "$MC" rcon-cli "gamerule doMobSpawning false" >/dev/null 2>&1 || true # older name
for m in slime zombie skeleton creeper spider husk drowned; do docker exec "$MC" rcon-cli "kill @e[type=minecraft:$m]" >/dev/null 2>&1 || true; done
docker run -d --name mcai-fake-model -p 18080:18080 -v "$MNT:/t" -w /t/out node:22-bookworm node /t/fake-model.mjs 18080 >/dev/null
CONFIG=$(printf '{"host":"host.docker.internal","port":%s,"mcVersion":"%s","model":"fake/scripted","thinking":"off","rpm":120,"dailyCap":0,"objective":"Test run. Your companions: {peers}.","agents":[{"name":"%s"},{"name":"%s"}]}' "$PORT" "$VER" "${AGENTS[0]}" "${AGENTS[1]}")
docker run -d --name mcai-live-test --add-host host.docker.internal:host-gateway \
  -e "AI_CONFIG=$CONFIG" -e AGENT_MODELS_FILE=/t/models.fake.json -v "$MNT:/t:ro" -v mcai-live-test-state:/data \
  craftpanel-ai-agents:latest >/dev/null

# Give each agent the items the script needs once it is in the game
for a in "${AGENTS[@]}"; do
  joined=no
  for i in $(seq 1 120); do docker logs --since "$START" "$MC" 2>&1 | grep -q "$a joined the game" && { joined=yes; break; }; sleep 1; done
  [ "$joined" = yes ] || { echo "FAIL: $a never joined the server"; docker logs mcai-live-test 2>&1 | tail -20; exit 1; }
  sleep 2
  for cmd in "give $a oak_log 8" "give $a bread 4" "give $a chest 1" "effect give $a minecraft:hunger 8 255"; do
    echo "  $cmd -> $(docker exec "$MC" rcon-cli "$cmd")"
  done
done

sleep "$SECS"
docker logs mcai-live-test > "$OUT/agents.log" 2>&1 || true
docker logs mcai-fake-model > "$OUT/fake-model.log" 2>&1 || true
echo "--- results (step: tool -> outcome)"
docker run --rm -v "$MNT:/t:ro" node:22-bookworm node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const calls = {};
for (const l of lines) if (l.call) calls[l.agent + ":" + l.step] = l.call;
let ok = 0, bad = 0;
for (const l of lines) if (l.result !== undefined) {
  const c = calls[l.agent + ":" + l.step] || "?";
  const failed = /"ok"\s*:\s*false|"error"|failureCode|"success"\s*:\s*false/.test(l.result);
  failed ? bad++ : ok++;
  console.log(`${l.agent} #${l.step} ${c.padEnd(14)} ${failed ? "FAIL" : "ok  "} ${l.result.slice(0, 160)}`);
}
for (const l of lines) if (l.event && l.event !== "listening") console.log(l.agent, l.event, l.tool || "", l.error || "");
console.log(`\n${ok} ok, ${bad} failed`);
' /t/out/fake-model.log
