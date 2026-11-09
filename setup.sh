#!/usr/bin/env bash
# One-time setup on a fresh AWS EC2 instance (Ubuntu 22.04/24.04 or Amazon Linux 2023).
# Usage:  bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Installing Docker (if missing)"
. /etc/os-release
if ! command -v docker >/dev/null 2>&1; then
  case "$ID" in
    ubuntu|debian)
      curl -fsSL https://get.docker.com | sudo sh ;;
    amzn)
      sudo dnf install -y docker
      ARCH=$(uname -m)
      sudo mkdir -p /usr/local/lib/docker/cli-plugins
      sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
      BX_ARCH=$([ "$ARCH" = "aarch64" ] && echo arm64 || echo amd64)
      BX_VER=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
      sudo curl -fsSL "https://github.com/docker/buildx/releases/download/${BX_VER}/buildx-${BX_VER}.linux-${BX_ARCH}" \
        -o /usr/local/lib/docker/cli-plugins/docker-buildx
      sudo chmod +x /usr/local/lib/docker/cli-plugins/* ;;
    *)
      echo "Unsupported OS: $ID. Install Docker + Docker Compose manually." ; exit 1 ;;
  esac
fi
sudo systemctl enable --now docker   # Docker starts on every reboot -> servers come back 24/7
sudo usermod -aG docker "$USER" || true

echo "==> Swap file (helps small instances avoid crashes)"
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Creating .env"
if [ ! -f .env ]; then
  cp .env.example .env
  PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  SECRET=$(openssl rand -hex 32)
  IP=$(curl -fsS https://checkip.amazonaws.com || echo "YOUR-SERVER-IP")
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${PASS}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${IP}|" .env
  echo "    Generated admin password: ${PASS}   (stored in .env)"
fi

# Open ports in the OS firewall if ufw is active (AWS Security Group must ALSO allow them)
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  set -a; . ./.env; set +a
  sudo ufw allow "${PANEL_PORT:-8080}/tcp"
  sudo ufw allow "${MC_PORT_START:-25565}:${MC_PORT_END:-25575}/tcp"
fi

echo "==> Pre-downloading Minecraft image (so first server creates fast)"
sudo docker pull itzg/minecraft-server:latest

echo "==> Starting panel"
sudo docker compose up -d --build

set -a; . ./.env; set +a
echo
echo "============================================================"
echo " Panel:     http://${PUBLIC_HOST}:${PANEL_PORT:-8080}"
echo " Password:  ${ADMIN_PASSWORD}"
echo " Open TCP ports ${PANEL_PORT:-8080} and ${MC_PORT_START:-25565}-${MC_PORT_END:-25575} in the AWS Security Group!"
echo "============================================================"
