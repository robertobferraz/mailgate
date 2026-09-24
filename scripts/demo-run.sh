#!/usr/bin/env bash
# The terminal story replayed by scripts/record-terminal.ts. Talks only to
# API_URL, never a hard-coded port, so the recording can run on any free port.
set -euo pipefail
API=${API_URL:-http://localhost:3000}
echo '$ curl -X POST /runs  # R$ 840,00, acima do limite'
ID=$(curl -s -X POST "$API/runs" -H 'content-type: application/json' \
  -d '{"description":"Hotel em SP (2 diárias)","amountCents":84000,"category":"TRAVEL","requesterEmail":"ana@acme.test","approverEmail":"gestor@acme.test"}' | jq -r .id)
echo "run $ID"
sleep 3
curl -s "$API/runs/$ID" | jq '{status, approval: .approval.status}'
echo '$ # gestor responde "pode aprovar" (webhook assinado)'
npx ts-node scripts/demo-reply.ts "pode aprovar"
sleep 4
curl -s "$API/runs/$ID" | jq '{status, action: .action.type}'
