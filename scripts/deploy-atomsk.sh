#!/usr/bin/env bash
set -euo pipefail

target="${FOUNDRY_DEPLOY_TARGET:-root@atomsk}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stamp="$(date -u +%Y%m%d-%H%M%S)"

while (($#)); do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    *) echo "Usage: $0 [--target user@host]" >&2; exit 64 ;;
  esac
done

for path in \
  "$root_dir/sidecar/index.js" \
  "$root_dir/sidecar/actor-utils.js" \
  "$root_dir/sidecar/bridge-auth.js" \
  "$root_dir/sidecar/Dockerfile" \
  "$root_dir/module/module.json" \
  "$root_dir/module/scripts/prepared-actor-bridge.mjs" \
  "$root_dir/traefik/foundry-mcp-bridge.yml"; do
  [[ -f "$path" ]] || { echo "Missing deployment source: $path" >&2; exit 66; }
done

ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "set -e
cp -p /mnt/user/appdata/compose/foundry-sidecar/index.js /mnt/user/appdata/compose/foundry-sidecar/index.js.backup-$stamp
cp -p /mnt/user/appdata/compose/foundry-sidecar/actor-utils.js /mnt/user/appdata/compose/foundry-sidecar/actor-utils.js.backup-$stamp
cp -p /mnt/user/appdata/compose/foundry-sidecar/bridge-auth.js /mnt/user/appdata/compose/foundry-sidecar/bridge-auth.js.backup-$stamp
cp -p /mnt/user/appdata/compose/foundry-sidecar/Dockerfile /mnt/user/appdata/compose/foundry-sidecar/Dockerfile.backup-$stamp
cp -p /mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/module.json /mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/module.json.backup-$stamp
cp -p /mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/scripts/prepared-actor-bridge.mjs /mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/scripts/prepared-actor-bridge.mjs.backup-$stamp
cp -p /mnt/user/appdata/traefik/config/dynamic/foundry-mcp-bridge.yml /mnt/user/appdata/traefik/config/dynamic/foundry-mcp-bridge.yml.backup-$stamp"

scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/sidecar/index.js" \
  "$root_dir/sidecar/actor-utils.js" \
  "$root_dir/sidecar/bridge-auth.js" \
  "$root_dir/sidecar/Dockerfile" \
  "$target:/mnt/user/appdata/compose/foundry-sidecar/"
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/module/module.json" \
  "$target:/mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/"
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/module/scripts/prepared-actor-bridge.mjs" \
  "$target:/mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/scripts/"
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/traefik/foundry-mcp-bridge.yml" \
  "$target:/mnt/user/appdata/traefik/config/dynamic/"

ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" \
  "cd /mnt/user/appdata/compose/foundry-stack && docker compose config -q && docker compose build foundry-sidecar && docker compose up -d foundry-sidecar"

"$root_dir/scripts/smoke-atomsk.sh" --target "$target"
echo "Sidecar deployment passed. Hard-refresh Foundry as a GM, then run: npm run smoke:atomsk -- --require-bridge"
