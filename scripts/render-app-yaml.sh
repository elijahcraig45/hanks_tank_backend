#!/bin/bash
# Renders app.yaml -> app.generated.yaml with secrets substituted in.
#
# app.yaml is public and holds only a __NEWS_API_KEY__ placeholder. The real value
# comes from the environment: a GitHub Actions secret in CI, or your shell locally.
#
# Local deploys:  export NEWS_API_KEY=... && npm run deploy
# Retrieve it with: gh secret list  (values are write-only; use your newsapi.org account)

set -euo pipefail

cd "$(dirname "$0")/.."

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

sed "s|__NEWS_API_KEY__|${NEWS_API_KEY}|" app.yaml > app.generated.yaml

if grep -q '__NEWS_API_KEY__' app.generated.yaml; then
    echo "ERROR: placeholder substitution failed" >&2
    exit 1
fi

echo "Rendered app.generated.yaml (NEWS_API_KEY injected, ${#NEWS_API_KEY} chars)"
