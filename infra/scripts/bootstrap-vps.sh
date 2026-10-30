#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu VPS. Run as root:
#   curl -fsSL <raw url> | bash -s -- "ssh-ed25519 AAAA... github-actions-deploy"
set -euo pipefail
DEPLOY_PUBKEY="${1:?usage: bootstrap-vps.sh '<deploy ssh public key>'}"

apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl ufw fail2ban unattended-upgrades rsync

# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh

# Deploy user used by GitHub Actions (docker group = effectively root, keep the key safe)
id deploy &>/dev/null || useradd -m -s /bin/bash -G docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
install -d -o deploy -g deploy /opt/app /opt/backups

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || systemctl restart ssh || systemctl restart sshd

# Firewall. Note: ports published by Docker bypass ufw, so only publish 80/443 in compose.
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw --force enable

# Swap for small (1 GB) machines
if [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/ {print $2}')" -lt 4000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

dpkg-reconfigure -f noninteractive unattended-upgrades
echo "Done. Now: copy .env to /opt/app/.env (owner deploy) and push to main."
