#!/usr/bin/env bash
# Records both README GIFs with DEMO=true (adr 0012). Needs: docker, gifski, jq,
# playwright chromium. (D016: vhs was dropped — it could exit 0 without ever
# writing a GIF; both GIFs are now Playwright + gifski, like record-timeline.ts.)
# PORT/API_URL are overridable so the recording can run alongside another
# service already bound to the default port 3000 on the host.
set -euo pipefail
for bin in docker gifski jq; do command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }; done
export PORT=${PORT:-3000}
export API_URL=${API_URL:-http://localhost:$PORT}
export DEMO_TMP="$(mktemp -d)"
export DEMO=true WORKER_POLL_MS=200
export AGENTMAIL_WEBHOOK_SECRET="whsec_$(printf 'mailgate-demo-secret-0123456789' | base64)"
export DATABASE_URL=postgresql://mailgate:mailgate@localhost:5432/mailgate
docker compose up -d --wait postgres
npx prisma migrate deploy
npm run build
node dist/main.js > /tmp/mailgate-demo.log 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null; rm -rf "$DEMO_TMP"' EXIT
until curl -fsS "$API_URL/health" >/dev/null; do sleep 0.5; done
npx playwright install chromium
npx ts-node scripts/record-terminal.ts
npx ts-node scripts/record-timeline.ts
test -s docs/assets/demo-terminal.gif || { echo "demo-terminal.gif missing or empty"; exit 1; }
test -s docs/assets/demo-timeline.gif || { echo "demo-timeline.gif missing or empty"; exit 1; }
ls -lh docs/assets/demo-*.gif
