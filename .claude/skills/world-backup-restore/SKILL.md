---
name: world-backup-restore
description: Back up, restore, or migrate a Minecraft server's world data (Docker volume mc-<name>-data), including the panel registry (servers.json). Use when the user asks about backups, restoring a world, moving servers to a new EC2 instance, or before risky changes.
---

# World backup / restore

Data locations:
- World + server config (`server.properties`, `ops.json`, `whitelist.json`, plugins): volume `mc-<name>-data` → `/data`
- Panel registry: volume `<project>_panel-data` → `/app/data/servers.json` (compose prefixes the
  project dir name, e.g. `minecraftserver_panel-data`; check with `sudo docker volume ls`)

## Backup (consistent)
```bash
N=<name>
sudo docker exec mc-$N rcon-cli save-off; sudo docker exec mc-$N rcon-cli save-all flush
sudo docker run --rm -v mc-$N-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/$N-$(date +%F).tgz -C /data .
sudo docker exec mc-$N rcon-cli save-on
```
(If the server is stopped, skip the rcon lines.) Keep the backups off-box (e.g. `aws s3 cp`).

Registry:
```bash
sudo docker cp mc-panel:/app/data/servers.json ./servers.json.bak
```

## Restore into an existing server
Destructive: **confirm with the user first** and make a fresh backup of the current state.
```bash
N=<name>
# stop via the panel (or: sudo docker stop -t 60 mc-$N)
sudo docker run --rm -v mc-$N-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/<file>.tgz -C /data"
# start via the panel
```

## Migrate to a new host
1. On the old host: back up every `mc-*-data` volume plus `servers.json`.
2. On the new host: run `setup.sh`, then copy the tarballs over.
3. Create the volumes and restore the tarballs as above (volume names must be exactly `mc-<name>-data`).
4. `sudo docker cp servers.json mc-panel:/app/data/servers.json && sudo docker compose restart panel`
5. Press **Start** on each server in the UI. The panel recreates missing containers from the registry.

## Built-in panel backups (preferred)
The panel has a **💾 Backups** tab (auto every `BACKUP_INTERVAL_HOURS`, before every settings change,
regenerate and restore, plus manual), and **Settings → 🌍 Regenerate world**. See "Backups" in `CLAUDE.md`.
The panel's backup files sit in the `mc-backups` volume: `/var/lib/docker/volumes/mc-backups/_data/<server>/*.tgz`
on the host. Those tarballs can be restored with the manual command above as well. The manual steps here are
for when the panel itself is broken, or for migrations.
