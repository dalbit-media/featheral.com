#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${1:?Deployment root required}"
release_id="${2:?Release ID required}"
email="${3:?TLS registration email required}"
hostnames="${4:?Public hostnames required}"
upload_mib="${5:-16}"
request_timeout="${6:-90}"
primary="${7:-true}"
[[ "$primary" == true || "$primary" == false ]]
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
exec 3>&1
phase() { printf 'FEATHERAL_PHASE:%s\n' "$1" >&3; }
step=provision
deployment_error() {
  local code=$?
  printf 'FEATHERAL_FAILURE:%s:%s\n' "$step" "$code" >&3
  exit "$code"
}
trap deployment_error ERR
exec > >(tee -a "$shared/logs/deployment.log" >&3) 2>&1
echo "Starting $release_id"
source /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || { echo "Ubuntu or Debian required"; exit 1; }
as_root true
phase provision
step=apt-update
phase "$step"
as_root apt-get update
step=apt-install
phase "$step"
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates gnupg nginx unzip curl certbot python3-certbot-nginx
if ! command -v node >/dev/null || ! node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'; then
  step=node-repository
  phase "$step"
  # Install Node through an HTTPS-fetched, signed APT repository, not a remote shell script.
  node_key="$release/nodesource.key"
  curl -fsS --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$node_key"
  gpg --batch --yes --dearmor --output "$release/nodesource.gpg" "$node_key"
  as_root install -m 644 "$release/nodesource.gpg" /usr/share/keyrings/nodesource.gpg
  printf '%s\n' "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > "$release/nodesource.list"
  as_root install -m 644 "$release/nodesource.list" /etc/apt/sources.list.d/nodesource.list
  step=node-update
  phase "$step"
  as_root apt-get update
  step=node-install
  phase "$step"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
step=node-check
phase "$step"
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
step=private-data
phase "$step"
installation=existing
if [[ "$primary" == true && " $hostnames " == *" admin.featheral.com "* && ! -e "$shared/data/system-database" && ! -e "$shared/bootstrap/bootstrap.json" ]]; then
  installation=new
fi
if [[ "$installation" == new ]]; then
  [[ ! -e "$root/current" && ! -L "$root/current" ]] || { echo "New installation cannot replace an existing release."; false; }
  for directory in "$shared/data" "$shared/cms-data"; do
    [[ ! -L "$directory" ]] || { echo "New installation cannot use linked private directories."; false; }
    if [[ -e "$directory" ]]; then
      [[ -d "$directory" && -z "$(ls -A "$directory")" ]] || { echo "New installation requires empty private directories."; false; }
    else
      mkdir "$directory"
    fi
  done
elif [[ "$hostnames" == db.featheral.com ]]; then
  # A DB-only host has no financial writers and can start with empty staged journals.
  mkdir -p "$shared/data" "$shared/cms-data"
else
  [[ -d "$shared/data/system-database" && -d "$shared/cms-data" ]] || {
    echo "First deployment requires existing private data, encrypted Settings and cms-data in $shared. Restore a consistent offline backup; never initialize a replacement economy."
    false
  }
fi
step=extract
phase "$step"
unzip -q "$release/release.zip" -d "$release"
rm "$release/release.zip"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({hosts:process.argv[2].split(" "),primary:process.argv[3]==="true",uploadLimitMiB:Number(process.argv[4]),requestTimeoutSeconds:Number(process.argv[5])}),{mode:0o600})' "$release/.deployment-hosts.json" "$hostnames" "$primary" "$upload_mib" "$request_timeout"
step=legacy-env
phase "$step"
[[ ! -e "$shared/.env" ]] || { echo "Migrate the shared .env into system Settings before deployment." >&2; false; }
step=link-data
phase "$step"
ln -s "$shared/data" "$release/data"
ln -s "$shared/cms-data" "$release/services/cms/data"
cd "$release"
phase dependencies
step=dependencies
npm ci
if [[ "$installation" == new ]]; then
  step=initialize
  phase "$step"
  export FEATHERAL_BOOTSTRAP_FILE="$shared/bootstrap/bootstrap.json"
  node -e 'require("./scripts/init-settings").initializeNewInstallation(process.cwd(),process.env.FEATHERAL_BOOTSTRAP_FILE,{uploadLimitMiB:Number(process.argv[1]),requestTimeoutSeconds:Number(process.argv[2])})' "$upload_mib" "$request_timeout"
elif [[ -f "$shared/bootstrap/bootstrap.json" ]]; then
  export FEATHERAL_BOOTSTRAP_FILE="$shared/bootstrap/bootstrap.json"
fi
step=runtime-settings
phase "$step"
gateway="$(node -e 'const fs=require("node:fs"),assignment=require("./.deployment-hosts.json"),dbOnly=assignment.hosts.length===1&&assignment.hosts[0]==="db.featheral.com";if(dbOnly&&!fs.existsSync("./data/system-database")){process.stdout.write("127.0.0.1:8080");process.exit(0)}const settings=require("./services/operations/runtime");const env=settings.environment(),host=env.HOST||"127.0.0.1";if(!["127.0.0.1","localhost","0.0.0.0","::","::1"].includes(host))throw new Error("Nginx deployment requires a local or wildcard HOST in Settings");process.stdout.write((host.includes(":")?"[::1]":"127.0.0.1")+":"+(env.PORT||"8080"))')"
if [[ "$hostnames" != db.featheral.com && "$primary" != true ]]; then
  node -e 'const env=require("./services/operations/runtime").environment();if(env.FTH_LEDGER_MODE!=="reader"||env.WORLD_LEDGER_MODE!=="reader"||(env.GOLD_RESERVE_MODE||"disabled")!=="disabled")throw new Error("Separate service servers require preconfigured financial readers; never run duplicate writers.")'
fi
step=world-dependencies
phase "$step"
npm ci --prefix sites/world.featheral.com/play
phase build
step=build
npm run abi
npm run build:world
step=pm2-install
phase "$step"
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
step=nginx-existing
phase "$step"
if as_root test -f "$nginx_file"; then
  as_root grep -q '^# Featheral managed gateway' "$nginx_file" || {
    echo "Existing Featheral Nginx configuration is not managed by this script. Review/migrate it before deploying."
    false
  }
  as_root cp "$nginx_file" "$nginx_backup"
  had_nginx=true
fi
activated=false
rollback() {
  code=$?
  trap - ERR
  printf 'FEATHERAL_FAILURE:%s:%s\n' "$step" "$code" >&3
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
phase nginx
step=nginx
# Do not overwrite other virtual hosts. Subsequent releases retain Certbot's TLS configuration.
if [[ "$had_nginx" != true ]]; then
  as_root install -m 644 "$candidate" "$nginx_file"
  as_root ln -s "$nginx_file" /etc/nginx/sites-enabled/featheral
else
  as_root sed -i -E "s/^[[:space:]]*server_name .*;/    server_name $hostnames;/; s/client_max_body_size [^;]+;/client_max_body_size ${upload_mib}m;/; s/proxy_read_timeout [^;]+;/proxy_read_timeout ${request_timeout}s;/; s/proxy_send_timeout [^;]+;/proxy_send_timeout ${request_timeout}s;/; s/client_body_timeout [^;]+;/client_body_timeout ${request_timeout}s;/; s@proxy_pass http://[^;]+;@proxy_pass http://${gateway};@" "$nginx_file"
  if ! as_root grep -q 'proxy_send_timeout' "$nginx_file"; then
    as_root sed -i "/proxy_read_timeout/a\\        proxy_send_timeout ${request_timeout}s;\\n        client_body_timeout ${request_timeout}s;" "$nginx_file"
  fi
fi
as_root nginx -t
# Resolve every assigned hostname before activation; Certbot subsequently verifies public reachability.
step=dns
phase "$step"
for host in $hostnames; do
  getent ahosts "$host" >/dev/null
done
if [[ "$hostnames" != db.featheral.com ]]; then
  step=import-pages
  phase "$step"
  FEATHERAL_DEPLOY_DIAGNOSTICS=1 node scripts/import-site-pages.js
fi
step=activate
phase "$step"
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
activated=true
step=pm2-start
phase "$step"
"$pm2" startOrRestart "$release/ecosystem.config.cjs" --update-env
step=pm2-startup
phase "$step"
"$pm2" save
as_root env PATH="$PATH" "$pm2" startup systemd -u "$(id -un)" --hp "$HOME"
pm2_service="pm2-$(id -un)"
if ! as_root systemctl is-active --quiet "$pm2_service"; then
  # A daemon created by this temporary deployment job dies when the job exits.
  # Stop it before resurrecting the saved processes under the persistent service.
  "$pm2" kill
  as_root systemctl start "$pm2_service"
fi
as_root systemctl is-active --quiet "$pm2_service"
step=health
phase "$step"
healthy=false
for attempt in $(seq 1 60); do
  if response="$(curl -fsS --max-time 3 "http://$gateway/healthz" 2>/dev/null)" &&
    printf '%s' "$response" | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{let health;try{health=JSON.parse(data)}catch{process.exit(1)}if(health.status!=="ok"||health.release!==process.argv[1])process.exit(1)});' "$release_id"; then healthy=true; break; fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo "Gateway did not report release $release_id at http://$gateway/healthz after 60 attempts. Recent application output:"
  for log in "$shared/logs/error.log" "$shared/logs/app.log"; do
    if [[ -f "$log" ]]; then
      echo "--- ${log##*/} (last 64 KiB, up to 80 lines) ---"
      tail -c 65536 -- "$log" | tail -n 80
    else
      echo "--- ${log##*/} is unavailable ---"
    fi
  done
  false
fi
for host in $hostnames; do
  # CMS is deliberately protected; an unauthenticated 401 is a healthy response.
  # Match Nginx's HTTPS forwarding when checking the loopback-only gateway.
  if ! status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Host: $host" -H "X-Forwarded-Proto: https" "http://$gateway/")"; then
    echo "Site health failed: $host (gateway request failed)."
    false
  fi
  echo "Site health: $host returned HTTP $status."
  if [[ "$status" != 200 && ! ( "$host" == admin.featheral.com && "$status" == 401 ) ]]; then
    echo "Site health failed: $host; expected HTTP 200 (or 401 for Admin)."
    false
  fi
done
as_root systemctl enable --now nginx
as_root systemctl reload nginx
certificate_args=()
for host in $hostnames; do certificate_args+=(-d "$host"); done
phase https
step=https
as_root certbot --nginx --non-interactive --agree-tos --email "$email" --redirect "${certificate_args[@]}"
as_root install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'set -eu' '/usr/sbin/nginx -t' '/bin/systemctl reload nginx' > "$release/renew-nginx"
as_root install -m 755 "$release/renew-nginx" /etc/letsencrypt/renewal-hooks/deploy/featheral-nginx
as_root systemctl enable --now certbot.timer
as_root systemctl is-active --quiet certbot.timer
as_root nginx -t
as_root systemctl reload nginx
for host in $hostnames; do
  if ! status="$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" --max-time 15 "https://$host/")"; then
    echo "HTTPS health failed: $host (TLS or connection error)."
    false
  fi
  echo "HTTPS health: $host returned HTTP $status."
  if [[ "$status" != 200 && ! ( "$host" == admin.featheral.com && "$status" == 401 ) ]]; then
    echo "HTTPS health failed: $host; expected HTTP 200 (or 401 for Admin)."
    false
  fi
done
echo "Deployment complete: $release_id"
phase verified
