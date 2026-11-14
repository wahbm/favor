#!/usr/bin/env bash
# One-time provisioning for the verified ECS. Run only after inspecting collisions.
# Credentials are generated on the server and never leave its protected environment file.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Root operator required' >&2; exit 1; }
source_dir=${1:?Usage: bootstrap-ecs.sh EXTRACTED_SOURCE_DIRECTORY}
project_root=/var/www/mosshqq/favor
nginx_site=/etc/nginx/conf.d/cloudbase-public-file-proxy.conf
snippet=/etc/nginx/snippets/favor.locations.conf
for file in favor-release favor.service nginx.locations.conf; do test -f "$source_dir/deploy/$file"; done
for candidate in "$project_root" /etc/favor /usr/local/sbin/favor-release /etc/systemd/system/favor.service /etc/sudoers.d/favor-deploy "$snippet"; do
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || { echo "Collision: $candidate" >&2; exit 1; }
done
if getent passwd favor >/dev/null; then echo 'Service user favor already exists' >&2; exit 1; fi
if systemctl cat favor.service >/dev/null 2>&1; then echo 'Service favor already exists' >&2; exit 1; fi
[[ "$(mariadb -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE SCHEMA_NAME='favor'")" == 0 ]]
[[ "$(mariadb -Nse "SELECT COUNT(*) FROM mysql.user WHERE User='favor'")" == 0 ]]
if ss -lnt | grep -q '127.0.0.1:3001 '; then echo 'Port 3001 occupied' >&2; exit 1; fi
/usr/bin/node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
nginx -t
python3 - "$nginx_site" <<'PY'
import pathlib,sys
content=pathlib.Path(sys.argv[1]).read_text()
assert content.count('    listen 443 ssl;')==1, 'HTTPS listener is ambiguous'
assert 'server_name 8.130.116.192;' in content
assert 'favor.locations.conf' not in content
PY
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin favor
install -d -o root -g root -m 0755 "$project_root"
install -d -o deploy -g deploy -m 0755 "$project_root/incoming" "$project_root/releases"
install -d -o root -g favor -m 0750 /etc/favor
install -d -o root -g root -m 0700 /var/backups/favor
umask 077
db_password=$(openssl rand -hex 32)
mariadb <<SQL
CREATE DATABASE favor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'favor'@'127.0.0.1' IDENTIFIED BY '$db_password';
GRANT ALL PRIVILEGES ON favor.* TO 'favor'@'127.0.0.1';
SQL
printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3001\nAPP_ORIGIN=https://8.130.116.192\nBASE_PATH=/mosshqq/favor\nDATABASE_URL=mysql://favor:%s@127.0.0.1:3306/favor\n' "$db_password" > /etc/favor/favor.env
unset db_password
chown root:favor /etc/favor/favor.env
chmod 0640 /etc/favor/favor.env
install -o root -g root -m 0755 "$source_dir/deploy/favor-release" /usr/local/sbin/favor-release
install -o root -g root -m 0644 "$source_dir/deploy/favor.service" /etc/systemd/system/favor.service
printf 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/favor-release *\n' > /etc/sudoers.d/favor-deploy.new
chmod 0440 /etc/sudoers.d/favor-deploy.new
visudo -cf /etc/sudoers.d/favor-deploy.new
mv /etc/sudoers.d/favor-deploy.new /etc/sudoers.d/favor-deploy
install -o root -g root -m 0644 "$source_dir/deploy/nginx.locations.conf" "$snippet"
cp -p "$nginx_site" /var/backups/favor/nginx-before-favor.conf
python3 - "$nginx_site" <<'PY'
import pathlib,sys
path=pathlib.Path(sys.argv[1]); content=path.read_text()
needle='    listen 443 ssl;'
assert content.count(needle)==1
path.write_text(content.replace(needle,needle+'\n    include /etc/nginx/snippets/favor.locations.conf;',1))
PY
if ! nginx -t; then
  cp -p /var/backups/favor/nginx-before-favor.conf "$nginx_site"
  nginx -t
  echo 'Nginx configuration restored; provisioning stopped' >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable favor.service
systemctl reload nginx
sudo -u deploy sudo -n -l /usr/local/sbin/favor-release verify-permission
printf 'FAVOR_PROVISIONED database=favor service=favor.service port=127.0.0.1:3001 path=/mosshqq/favor/\n'
