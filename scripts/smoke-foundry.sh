#!/usr/bin/env bash
set -euo pipefail

target="${FOUNDRY_DEPLOY_TARGET:?Set FOUNDRY_DEPLOY_TARGET=user@host}"
require_bridge=false
audit_journal_visibility=false

while (($#)); do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --require-bridge) require_bridge=true; shift ;;
    --audit-journal-visibility) require_bridge=true; audit_journal_visibility=true; shift ;;
    *) echo "Usage: FOUNDRY_DEPLOY_TARGET=user@host $0 [--target user@host] [--require-bridge] [--audit-journal-visibility]" >&2; exit 64 ;;
  esac
done

for _attempt in 1 2 3 4 5; do
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" \
    "docker exec -i foundry-sidecar node - '$require_bridge' '$audit_journal_visibility'" <<'NODE'
const requireBridge = process.argv[2] === "true";
const auditVisibility = process.argv[3] === "true";

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

if (!response.ok) { console.log(JSON.stringify(result)); process.exit(1); }
if (requireBridge && responders.length === 0) { console.log(JSON.stringify(result)); process.exit(2); }

if (auditVisibility) {
  const auditResponse = await fetch("http://127.0.0.1:30001/api/mcp/journal/visibility-audit", {
    method: "POST",
    headers: { "X-API-Key": process.env.API_KEY },
  });
  const audit = await auditResponse.json().catch(() => ({}));
  result.journalVisibilityAudit = {
    ok: audit.ok ?? null,
    checked: audit.checked ?? null,
    disagreements: audit.disagreements?.length ?? null,
  };
  console.log(JSON.stringify(result));
  if (!auditResponse.ok) process.exit(1);
  if (audit.ok !== true) process.exit(3);
} else {
  console.log(JSON.stringify(result));
}
NODE
  then
    echo "Foundry sidecar smoke check passed."
    exit 0
  fi
  sleep 3
done

echo "Foundry sidecar smoke check failed. Inspect the sidecar logs; credentials were not printed." >&2
echo "Exit code 3 from the inner check means the journal-visibility conformance audit found a disagreement — do not treat that as a transient failure worth retrying past." >&2
exit 1
