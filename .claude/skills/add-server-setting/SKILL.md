---
name: add-server-setting
description: Add or change a per-server Minecraft setting (a server.properties / itzg env option such as max-world-size, allow-nether, enforce-secure-profile, icon) end to end, from backend validation through container env to the settings form. Use whenever the user wants a new configurable option on a Minecraft server in CraftPanel.
---

# Add a server setting

A setting touches 4 places, and they must stay in sync. Make all the edits in one go.

## 1. Find the itzg env var
Look up the variable in the itzg docs (https://docker-minecraft-server.readthedocs.io/, "Server properties").
Most properties map as `kebab-case` → `UPPER_SNAKE` (e.g. `allow-nether` → `ALLOW_NETHER`).
Don't guess when unsure. Check the docs.

## 2. Backend: `panel/server.js`
1. **`DEFAULTS`**: add `camelCaseKey: <default>`. Pick the Minecraft/itzg default so existing
   servers don't change behaviour. Old registry entries don't have the key, but `sanitize` merges
   `DEFAULTS` first, so they get the default.
2. **Validation in `sanitize()`**, chosen by type:
   - enum → add to `ENUMS` (it's also sent to the UI through `/api/config`)
   - integer → `int('key', min, max)`
   - boolean → add the key to the boolean list (`['onlineMode', 'pvp', ...]`)
   - free text → `clean(input.key, maxLen)`. Control chars are stripped. Never pass unbounded text.
   - Anything else gets an explicit regex and throws `BadRequest` with a clear message.
3. **`buildEnv()`**: map it, e.g. `ALLOW_NETHER: s.allowNether`. Only add optional vars when they're set
   (see the `SEED`/`WHITELIST` pattern) when an empty value would mean something different from "unset".

## 3. Frontend: `panel/public/app.js`
1. Add an entry to **`FIELDS`** under the right `section`:
   `{ key, label, type: 'text'|'number'|'select'|'check', enum?: 'ENUMS key', options?: [...], min?, max?, hint?, full?, createOnly? }`.
   Write the hint in Hinglish to match the existing copy (e.g. `'Nether portal kaam karega'`).
2. If it's worth seeing at a glance, add it to the `info` array in `renderOverviewTab`.
3. `readForm` picks it up automatically through `name=key`. Checkboxes send booleans.

## 4. Docs
If the setting matters to users (security, joining, performance), mention it in `README.md` (Hinglish).

## Notes
- Saving settings recreates the container (`PUT` → `removeContainer` + `createContainer`). The world is safe.
- World-generation options (seed, level type, generator settings) only apply to a new world.
  Put them in the "🌍 World" section, which already says so.
- Verify with `node --check panel/server.js && node --check panel/public/app.js`, then the
  `local-dev-smoke-test` skill if Docker is running: create a server, change the setting, and run
  `docker exec mc-<name> cat /data/server.properties | grep <prop>`.
