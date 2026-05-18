#!/usr/bin/env bash
set -euo pipefail

# Keys pushed as GitHub Secrets (sensitive values)
SECRET_KEYS=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_D1_DATABASE_ID
  GEMINI_API_KEY
  JINA_API_KEY
)

ENV_FILE="${1:-./.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found" >&2
  echo "Copy .env.example to .env and fill in the values." >&2
  exit 1
fi

source "$ENV_FILE"

push_secret() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf "  secret  %s\n" "$key"
    gh secret set "$key" --body "${!key}"
  else
    printf "  SKIP    %s  (not in %s)\n" "$key" "$ENV_FILE"
  fi
}

echo "==> GitHub Secrets"
for key in "${SECRET_KEYS[@]}"; do push_secret "$key"; done

echo "Done."
