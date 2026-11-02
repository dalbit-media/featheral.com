#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${1:?Deployment root required}"
release_id="${2:?Release ID required}"
email="${3:?TLS registration email required}"
hostnames="${4:?Public hostnames required}"
upload_mib="${5:-16}"
request_timeout="${6:-90}"
[[ "$upload_mib" =~ ^[0-9]+$ && "$upload_mib" -ge 1 && "$upload_mib" -le 1024 ]]
[[ "$request_timeout" =~ ^[0-9]+$ && "$request_timeout" -ge 5 && "$request_timeout" -le 3600 ]]
sudo_password=""
IFS= read -r sudo_password || true
exec </dev/null
as_root() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  elif [[ -n "$sudo_password" ]]; then
    printf '%s\n' "$sudo_password" | sudo -S -p '' -- "$@"
  else
    sudo -n -- "$@"
  fi
}
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
as_root true
as_root apt-get update
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates gnupg nginx unzip curl certbot python3-certbot-nginx
if ! command -v node >/dev/null || ! node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'; then
  # Install Node through an HTTPS-fetched, signed APT repository, not a remote shell script.
  node_key="$release/nodesource.key"
  curl -fsS --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$node_key"
  gpg --batch --yes --dearmor --output "$release/nodesource.gpg" "$node_key"
  as_root install -m 644 "$release/nodesource.gpg" /usr/share/keyrings/nodesource.gpg
  printf '%s\n' "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > "$release/nodesource.list"
  as_root install -m 644 "$release/nodesource.list" /etc/apt/sources.list.d/nodesource.list
  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
[[ -d "$shared/data/system-database" && -d "$shared/cms-data" ]] || {
  echo "First deployment requires existing private data, encrypted Settings and cms-data in $shared. Restore a consistent offline backup; never initialize a replacement economy."
  exit 1
}
unzip -q "$release/release.zip" -d "$release"
rm "$release/release.zip"
[[ ! -e "$shared/.env" ]] || { echo "Migrate the shared .env into system Settings before deployment." >&2; exit 1; }
ln -s "$shared/data" "$release/data"
ln -s "$shared/cms-data" "$release/services/cms/data"
cd "$release"
npm ci
gateway="$(node -e 'const settings=require("./services/operations/runtime");if(!settings.adminConfigured())throw new Error("Restore the external bootstrap/key and Admin settings before deployment");const env=settings.environment(),host=env.HOST||"127.0.0.1";if(!["127.0.0.1","localhost","0.0.0.0","::","::1"].includes(host))throw new Error("Nginx deployment requires a local or wildcard HOST in Settings");process.stdout.write((host.includes(":")?"[::1]":"127.0.0.1")+":"+(env.PORT||"8080"))')"
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
    client_max_body_size DEPLOY_UPLOAD_MIBm;
    location / {
        proxy_pass http://DEPLOY_GATEWAY;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout DEPLOY_TIMEOUTs;
        proxy_send_timeout DEPLOY_TIMEOUTs;
        client_body_timeout DEPLOY_TIMEOUTs;
    }
}
NGINX
sed -i "s/DEPLOY_HOSTNAMES/$hostnames/" "$candidate"
sed -i "s/DEPLOY_UPLOAD_MIB/$upload_mib/g; s/DEPLOY_TIMEOUT/$request_timeout/g" "$candidate"
sed -i "s/DEPLOY_GATEWAY/$gateway/g" "$candidate"
previous="$(readlink -f "$root/current" || true)"
nginx_file="/etc/nginx/sites-available/featheral"
nginx_backup="$release/nginx.previous"
had_nginx=false
if as_root test -f "$nginx_file"; then
  as_root grep -q '^# Featheral managed gateway' "$nginx_file" || {
    echo "Existing Featheral Nginx configuration is not managed by this script. Review/migrate it before deploying."
    exit 1
  }
  as_root cp "$nginx_file" "$nginx_backup"
  had_nginx=true
fi
activated=false
rollback() {
  code=$?
  trap - ERR
  echo "Deployment failed ($code); restoring the prior code/configuration, never monetary data."
  if [[ "$had_nginx" == true ]]; then
    as_root cp "$nginx_backup" "$nginx_file"
  else
    as_root rm -f /etc/nginx/sites-enabled/featheral "$nginx_file"
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
  as_root nginx -t
  as_root systemctl reload nginx
  exit "$code"
}
trap rollback ERR
# Do not overwrite other virtual hosts. Subsequent releases retain Certbot's TLS configuration.
if [[ "$had_nginx" != true ]]; then
  as_root install -m 644 "$candidate" "$nginx_file"
  as_root ln -s "$nginx_file" /etc/nginx/sites-enabled/featheral
else
  as_root sed -i -E "s/^[[:space:]]*server_name .*;/    server_name $hostnames;/; s/client_max_body_size [^;]+;/client_max_body_size ${upload_mib}m;/; s/proxy_read_timeout [^;]+;/proxy_read_timeout ${request_timeout}s;/; s/proxy_send_timeout [^;]+;/proxy_send_timeout ${request_timeout}s;/; s/client_body_timeout [^;]+;/client_body_timeout ${request_timeout}s;/" "$nginx_file"
  if ! as_root grep -q 'proxy_send_timeout' "$nginx_file"; then
    as_root sed -i "/proxy_read_timeout/a\\        proxy_send_timeout ${request_timeout}s;\\n        client_body_timeout ${request_timeout}s;" "$nginx_file"
  fi
fi
as_root nginx -t
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
  if curl -fsS --max-time 3 "http://$gateway/healthz" | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{const health=JSON.parse(data);if(health.status!=="ok"||health.release!==process.argv[1])process.exit(1)});' "$release_id"; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]
for host in $hostnames; do
  # CMS is deliberately protected; an unauthenticated 401 is a healthy response.
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Host: $host" "http://$gateway/")"
  [[ "$status" == 200 || "$host" == admin.featheral.com && "$status" == 401 ]]
done
"$pm2" save
as_root env PATH="$PATH" "$pm2" startup systemd -u "$(id -un)" --hp "$HOME"
as_root systemctl enable --now nginx
as_root systemctl reload nginx
certificate_args=()
for host in $hostnames; do certificate_args+=(-d "$host"); done
as_root certbot --nginx --non-interactive --agree-tos --email "$email" --redirect "${certificate_args[@]}"
as_root install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'set -eu' '/usr/sbin/nginx -t' '/bin/systemctl reload nginx' > "$release/renew-nginx"
as_root install -m 755 "$release/renew-nginx" /etc/letsencrypt/renewal-hooks/deploy/featheral-nginx
as_root systemctl enable --now certbot.timer
as_root systemctl is-active --quiet certbot.timer
as_root nginx -t
as_root systemctl reload nginx
for host in $hostnames; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" --max-time 15 "https://$host/")"
  [[ "$status" == 200 || "$host" == admin.featheral.com && "$status" == 401 ]]
done
echo "Deployment complete: $release_id"
