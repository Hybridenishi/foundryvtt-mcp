#!/usr/bin/env bash
set -euo pipefail

target="${FOUNDRY_DEPLOY_TARGET:?Set FOUNDRY_DEPLOY_TARGET=user@host}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stamp="$(date -u +%Y%m%d-%H%M%S)"
compose_dir="${FOUNDRY_COMPOSE_DIR:?Set FOUNDRY_COMPOSE_DIR=/path/to/compose-directory}"
sidecar_dir="${FOUNDRY_SIDECAR_DIR:?Set FOUNDRY_SIDECAR_DIR=/path/to/sidecar-directory}"
module_dir="${FOUNDRY_MODULE_DIR:?Set FOUNDRY_MODULE_DIR=/path/to/foundry/Data/modules/foundry-mcp-bridge}"
proxy_config_dir="${FOUNDRY_PROXY_CONFIG_DIR:-}"

while (($#)); do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    *) echo "Usage: configure FOUNDRY_* deployment paths, then run $0 [--target user@host]" >&2; exit 64 ;;
  esac
done

for path in \
  "$root_dir/sidecar/index.js" \
  "$root_dir/sidecar/actor-utils.js" \
  "$root_dir/sidecar/bridge-auth.js" \
  "$root_dir/sidecar/confirmation.js" \
  "$root_dir/sidecar/Dockerfile" \
  "$root_dir/module/module.json" \
  "$root_dir/module/scripts/prepared-actor-bridge.mjs"; do
  [[ -f "$path" ]] || { echo "Missing deployment source: $path" >&2; exit 66; }
done

if [[ -n "$proxy_config_dir" ]]; then
  [[ -f "$root_dir/traefik/foundry-mcp-bridge.yml" ]] || { echo "Missing proxy example configuration." >&2; exit 66; }
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "cp -p '$proxy_config_dir/foundry-mcp-bridge.yml' '$proxy_config_dir/foundry-mcp-bridge.yml.backup-$stamp'"
fi

ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "set -e
cp -p '$sidecar_dir/index.js' '$sidecar_dir/index.js.backup-$stamp'
cp -p '$sidecar_dir/actor-utils.js' '$sidecar_dir/actor-utils.js.backup-$stamp'
cp -p '$sidecar_dir/bridge-auth.js' '$sidecar_dir/bridge-auth.js.backup-$stamp'
cp -p '$sidecar_dir/confirmation.js' '$sidecar_dir/confirmation.js.backup-$stamp'
cp -p '$sidecar_dir/Dockerfile' '$sidecar_dir/Dockerfile.backup-$stamp'
cp -p '$module_dir/module.json' '$module_dir/module.json.backup-$stamp'
cp -p '$module_dir/scripts/prepared-actor-bridge.mjs' '$module_dir/scripts/prepared-actor-bridge.mjs.backup-$stamp'"

scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/sidecar/index.js" \
  "$root_dir/sidecar/actor-utils.js" \
  "$root_dir/sidecar/bridge-auth.js" \
  "$root_dir/sidecar/confirmation.js" \
  "$root_dir/sidecar/Dockerfile" \
  "$target:$sidecar_dir/"
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/module/module.json" \
  "$target:$module_dir/"
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$root_dir/module/scripts/prepared-actor-bridge.mjs" \
  "$target:$module_dir/scripts/"
if [[ -n "$proxy_config_dir" ]]; then
  scp -o BatchMode=yes -o ConnectTimeout=8 "$root_dir/traefik/foundry-mcp-bridge.yml" "$target:$proxy_config_dir/"
fi

ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" \
  "cd '$compose_dir' && docker compose config -q && docker compose build foundry-sidecar && docker compose up -d foundry-sidecar"

"$root_dir/scripts/smoke-foundry.sh" --target "$target"
echo "Sidecar deployment passed. Hard-refresh Foundry as a GM, then run: npm run smoke:foundry -- --require-bridge"
