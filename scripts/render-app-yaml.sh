#!/bin/bash
# Renders app.yaml -> app.generated.yaml with secrets substituted in.
#
# app.yaml is public and holds only __PLACEHOLDER__ tokens. The real values come from
# the environment: GitHub Actions secrets in CI, or your shell locally.
#
# Local deploys:  export NEWS_API_KEY=... && npm run deploy
# Retrieve NEWS_API_KEY with: gh secret list  (values are write-only; use your
# newsapi.org account)
#
# CFBD_API_KEY is different: it already lives in Secret Manager, because the ML
# pipeline's Cloud Function reads it from there. Rather than ask you to keep a second
# copy in your shell, this pulls it from the same place. Set CFBD_API_KEY explicitly
# to override, which is what CI does.

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${GCP_PROJECT_ID:-hankstank}"

if [ -z "${NEWS_API_KEY:-}" ]; then
    cat >&2 <<'EOF'
ERROR: NEWS_API_KEY is not set, refusing to render app.yaml.

Deploying without it would push the literal "__NEWS_API_KEY__" to App Engine and
silently disable news endpoints (news.service.ts logs a warning and no-ops).

  export NEWS_API_KEY='<key from newsapi.org>'
  npm run deploy
EOF
    exit 1
fi

# Fall back to Secret Manager so the key has one home rather than two.
if [ -z "${CFBD_API_KEY:-}" ]; then
    CFBD_API_KEY="$(gcloud secrets versions access latest \
        --secret=cfbd-api-key --project="$PROJECT" 2>/dev/null || true)"
fi

if [ -z "${CFBD_API_KEY:-}" ]; then
    cat >&2 <<EOF
ERROR: CFBD_API_KEY is not set and could not be read from Secret Manager, refusing
to render app.yaml.

Deploying without it would push the literal "__CFBD_API_KEY__" and the live college
scoreboard, schedule and game pages would report themselves unavailable.

  gcloud secrets versions access latest --secret=cfbd-api-key --project=$PROJECT
  # or, to override:
  export CFBD_API_KEY='<key from collegefootballdata.com/key>'
  npm run deploy
EOF
    exit 1
fi

sed -e "s|__NEWS_API_KEY__|${NEWS_API_KEY}|" \
    -e "s|__CFBD_API_KEY__|${CFBD_API_KEY}|" \
    app.yaml > app.generated.yaml

for placeholder in __NEWS_API_KEY__ __CFBD_API_KEY__; do
    if grep -q "$placeholder" app.generated.yaml; then
        echo "ERROR: $placeholder substitution failed" >&2
        exit 1
    fi
done

echo "Rendered app.generated.yaml (NEWS_API_KEY ${#NEWS_API_KEY} chars, CFBD_API_KEY ${#CFBD_API_KEY} chars)"
