#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${1:?Deployment root required}"
release_id="${2:?Release ID required}"
email="${3:?TLS registration email required}"
hostnames="${4:?Public hostnames required}"
for host in $hostnames; do [[ "$host" =~ ^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$ ]]; done
[[ "$root" =~ ^/[a-zA-Z0-9/_-]+$ && "$root" != / && "$root" != *"/../"* ]]
[[ "$release_id" =~ ^release-[0-9]+-[a-f0-9]{12}$ ]]
release="$root/releases/$release_id"
shared="$root/shared"
mkdir -p "$shared/logs"
exec >>"$shared/logs/deployment.log" 2>&1
echo "Starting $release_id"
source /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || { echo "Ubuntu or Debian required"; exit 1; }
command -v node >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
sudo -n true
sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y nginx unzip curl certbot python3-certbot-nginx
[[ -f "$shared/.env" && -d "$shared/data" && -d "$shared/cms-data" ]] || {
  echo "First deployment requires existing private .env, data and cms-data in $shared. Restore a consistent offline backup; never initialize a replacement economy."
  exit 1
}
grep -Eq '^CMS_PASSWORD=.+$' "$shared/.env" || { echo "CMS_PASSWORD is required"; exit 1; }
unzip -q "$release/release.zip" -d "$release"
rm "$release/release.zip"
ln -s "$shared/.env" "$release/.env"
ln -s "$shared/data" "$release/data"
ln -s "$shared/cms-data" "$release/services/cms/data"
cd "$release"
npm ci
npm ci --prefix sites/world.featheral.com/play
npm run abi
npm run build:world
mkdir -p "$shared/tools"
[[ -x "$shared/tools/node_modules/.bin/pm2" ]] || npm install --prefix "$shared/tools" --no-save pm2@6
pm2="$shared/tools/node_modules/.bin/pm2"
candidate="$release/nginx-featheral.conf"
cat >"$candidate" <<'NGINX'
# Featheral managed gateway
server {
    listen 80;
    server_name DEPLOY_HOSTNAMES;
    client_max_body_size 16m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 90s;
    }
}
NGINX
sed -i "s/DEPLOY_HOSTNAMES/$hostnames/" "$candidate"
previous="$(readlink -f "$root/current" || true)"
nginx_file="/etc/nginx/sites-available/featheral"
nginx_backup="$release/nginx.previous"
had_nginx=false
if sudo -n test -f "$nginx_file"; then
  sudo -n grep -q '^# Featheral managed gateway' "$nginx_file" || {
    echo "Existing Featheral Nginx configuration is not managed by this script. Review/migrate it before deploying."
    exit 1
  }
  sudo -n cp "$nginx_file" "$nginx_backup"
  had_nginx=true
fi
activated=false
rollback() {
  code=$?
  trap - ERR
  echo "Deployment failed ($code); restoring the prior code/configuration, never monetary data."
  if [[ "$had_nginx" == true ]]; then
    sudo -n cp "$nginx_backup" "$nginx_file"
  else
    sudo -n rm -f /etc/nginx/sites-enabled/featheral "$nginx_file"
  fi
  if [[ "$activated" == true ]]; then
    if [[ -n "$previous" ]]; then
      ln -sfn "$previous" "$root/current.next"
      mv -Tf "$root/current.next" "$root/current"
      "$pm2" startOrRestart "$previous/ecosystem.config.cjs" --update-env
      "$pm2" save
    else
      "$pm2" delete featheral
      rm -f "$root/current"
    fi
  fi
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  exit "$code"
}
trap rollback ERR
# Do not overwrite other virtual hosts. Subsequent releases retain Certbot's TLS configuration.
if [[ "$had_nginx" != true ]]; then
  sudo -n install -m 644 "$candidate" "$nginx_file"
  sudo -n ln -s "$nginx_file" /etc/nginx/sites-enabled/featheral
else
  sudo -n sed -i -E "s/^[[:space:]]*server_name .*;/    server_name $hostnames;/" "$nginx_file"
fi
sudo -n nginx -t
# Check that the requested hostnames actually route to this server before requesting certificates.
for host in $hostnames; do
  getent ahosts "$host" >/dev/null
done
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
activated=true
node scripts/import-site-pages.js
"$pm2" startOrRestart "$release/ecosystem.config.cjs" --update-env
healthy=false
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/healthz | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{const health=JSON.parse(data);if(health.status!=="ok"||health.release!==process.argv[1])process.exit(1)});' "$release_id"; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]
for host in $hostnames; do
  # CMS is deliberately protected; an unauthenticated 401 is a healthy response.
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Host: $host" http://127.0.0.1:8080/)"
  [[ "$status" == 200 || "$host" == admin.featheral.com && "$status" == 401 ]]
done
"$pm2" save
sudo -n env PATH="$PATH" "$pm2" startup systemd -u "$(id -un)" --hp "$HOME"
sudo -n systemctl enable --now nginx
sudo -n systemctl reload nginx
certificate_args=()
for host in $hostnames; do certificate_args+=(-d "$host"); done
sudo -n certbot --nginx --non-interactive --agree-tos --email "$email" --redirect "${certificate_args[@]}"
sudo -n nginx -t
sudo -n systemctl reload nginx
for host in $hostnames; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" --max-time 15 "https://$host/")"
  [[ "$status" == 200 || "$host" == admin.featheral.com && "$status" == 401 ]]
done
echo "Deployment complete: $release_id"
