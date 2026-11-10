---
name: deploy-update
description: Deploy or update CraftPanel on the AWS EC2 host (first-time setup.sh, pulling new code, rebuilding the panel, changing .env such as password or PUBLIC_HOST/Elastic IP). Use when the user asks to deploy, ship, update the server, or change panel configuration in production.
---

# Deploy / update on EC2

All of this runs **on the EC2 host over SSH**. Claude usually can't reach it, so give the user exact
commands to run, or run them if they've given SSH access. Never commit `.env`.

## First time
See README §1–2: Ubuntu 24.04, `t3.medium`+, 20 GB+ storage, Security Group 22 (my IP),
8080 (ideally my IP), 25565-25575 (0.0.0.0/0), Elastic IP.
```bash
git clone https://github.com/DEV-GHILDIYAL/MinecraftServer.git && cd MinecraftServer && bash setup.sh
```
`setup.sh` prints the panel URL and the generated password.

## Update the panel code
```bash
cd ~/MinecraftServer
git pull
sudo docker compose up -d --build
sudo docker compose logs --tail 30 panel
```
Rebuilding the panel **doesn't** touch Minecraft containers or worlds. `mc-*` containers keep running
and the registry lives in the `panel-data` volume.

Before pushing changes that affect containers (`buildEnv`, `createContainer`, image tags), remember that
existing servers only pick up the change when they're recreated, i.e. the next time settings are saved
in the UI.

## Change config
- Password: edit `ADMIN_PASSWORD` in `.env`, then `sudo docker compose up -d`. Existing sessions stay
  valid until `SESSION_SECRET` changes. Rotate it as well to log everyone out.
- New Elastic IP / domain: update `PUBLIC_HOST`, then `sudo docker compose up -d`.
- More ports: widen `MC_PORT_START/END` **and** the Security Group (+ ufw if active).

## Pre-deploy checklist
- `node --check panel/server.js && node --check panel/public/app.js`
- The change was smoke-tested locally (`local-dev-smoke-test`)
- Auth / docker-exec / filesystem changes were reviewed by `panel-security-reviewer`
- Recommend a world backup before risky changes (`world-backup-restore`)
