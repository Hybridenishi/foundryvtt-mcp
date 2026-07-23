#!/usr/bin/env bash
set -euo pipefail

target="${FOUNDRY_DEPLOY_TARGET:?Set FOUNDRY_DEPLOY_TARGET=user@host}"
require_bridge=false

while (($#)); do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --require-bridge) require_bridge=true; shift ;;
    *) echo "Usage: FOUNDRY_DEPLOY_TARGET=user@host $0 [--target user@host] [--require-bridge]" >&2; exit 64 ;;
  esac
done

for _attempt in 1 2 3 4 5; do
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" \
    "docker exec -i foundry-sidecar node - '$require_bridge'" <<'NODE'
const requireBridge = process.argv[2] === "true";

const response = await fetch("http://127.0.0.1:30001/api/mcp/system-info", {
  headers: { "X-API-Key": process.env.API_KEY },
});
const data = await response.json().catch(() => ({}));
const responders = data.preparedActorBridge?.responders ?? [];
const result = {
  sidecarStatus: response.status,
  foundryVersion: data.foundryVersion ?? null,
  system: data.system?.id ?? null,
  responderCount: responders.length,
};
console.log(JSON.stringify(result));

if (!response.ok) process.exit(1);
if (requireBridge && responders.length === 0) process.exit(2);
NODE
  then
    echo "Foundry sidecar smoke check passed."
    exit 0
  fi
  sleep 3
done

echo "Foundry sidecar smoke check failed. Inspect the sidecar logs; credentials were not printed." >&2
exit 1
