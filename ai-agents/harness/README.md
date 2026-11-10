# Harness overrides for Minecraft 26.1

Upstream [minecraft-agent-harness](https://github.com/yc-software/minecraft-agent-harness) (commit `775d558`) pins
mineflayer 4.33, which only speaks up to 1.21.8. CraftPanel servers run 26.1.x, so the `Dockerfile` copies these files
over the cloned harness before `npm ci`:

| File | Change |
|---|---|
| `package.json` | `mineflayer` 4.33.0 → **4.39.0** (tested up to 26.1), `minecraft-data` 3.116.0 → **3.119.0** (has 26.1 data). Everything else is unchanged |
| `package-lock.json` | Lockfile for the above, so every build installs exactly the same tree |
| `patches/mineflayer+4.39.0.patch` | Replaces `mineflayer+4.33.0.patch` (deleted in the image). See below |

Protocol 775 covers 26.1, 26.1.1 and 26.1.2. The panel passes `minecraftVersion: "26.1"` for all three.
26.2 (776) and 26.3 (777) aren't supported by any mineflayer release yet.

## What happened to each hunk of the old mineflayer patch

| Old hunk | In 4.39 |
|---|---|
| `digging.js`: `isInWater` → `false` | **dropped**: upstream now checks for water at eye level, which is the correct fix |
| `digging.js`: `incorrect_for_wooden_tool` → `mineable/pickaxe` | **kept**: 26.1 data still has 108 blocks with that material |
| `entities.js`: `entity_velocity` reads `packet.velocity` | **replaced** with a bigger fix: upstream reads `packet.velocity` but still divides by 8000. From 1.21.9 (so also 26.1) `entity_velocity` and `spawn_entity` carry an `lpVec3` that is already in blocks/tick, so unpatched 4.39 shrinks every knockback to ~0. The patch picks the unit from the version's protocol definition and keeps the old flat `velocityX/Y/Z` fallback. Covered by `../test/velocity.test.mjs` (3 of 4 cases fail without the patch) |
| `entities.js`: `sync_entity_position` uses `velocity.set` | **dropped**: upstream does the same |
| `inventory.js`: per-window `stateId` map | **kept** (ported): upstream still keeps one global stateId, but vanilla keeps one counter per container menu |
| `inventory.js`: `use_item` sends the real yaw/pitch | **dropped**: upstream does the same |
| `place_block.js`: timeout 5000 → 500 | **dropped**: `placeBlock` was rewritten and now settles as soon as the server acknowledges |

The patches for `mineflayer-pathfinder` 2.4.5, `mineflayer-collectblock` 1.6.0, `mineflayer-pvp` 1.3.2 and `protodef`
1.19.0 are unchanged because those packages are still on the same versions.

## How it was verified (2026-11-10)

- Harness unit tests (`test/body`, `test/tools`, `test/skills`, `test/agent`, `test/comms` and the top-level tests)
  with the upgraded tree: all pass. `test/model/compatible-endpoint` and `test/tools/shell-tools` hang in a plain
  container because they need a model endpoint and a shell sandbox. Neither touches mineflayer, and CraftPanel runs
  with `sandbox: none`.
- `../test/velocity.test.mjs` against real 26.1 and 1.21.6 packet encodings.
- `../test/run-live-test.sh` against a vanilla **26.1.2** server: two agents crafted a pickaxe (placing and using a
  crafting table), equipped it, gathered, placed and broke blocks, ate, used a chest (deposit and withdraw),
  pathfound and exchanged DMs. 43/44 steps passed. The one "failure" is the harness deliberately interrupting an
  action when a DM arrives.

## Bumping again

1. Change versions in `package.json`, regenerate the lockfile inside `node:22-bookworm` (`npm install`), and port the patch.
2. Run the harness unit tests (`npm test`) and the live test in `../test/` against a real server of the target version.
3. Update `aiProtocolFor()` in `panel/server.js`.
