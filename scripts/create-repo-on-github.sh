#!/usr/bin/env bash
# Create github.com/dallasrlones/aerekos-record (if missing) and push main.
# Usage:
#   export GH_TOKEN=ghp_...   # classic PAT with "repo", or fine-grained with repo create + contents
#   ./scripts/create-repo-on-github.sh
#
# Or: run `gh auth login` in your terminal, then:
#   gh repo create dallasrlones/aerekos-record --public --source=. --remote=origin --push --description "Universal ORM for Node.js"

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "Set GH_TOKEN (or GITHUB_TOKEN) to a PAT that can create repositories under your account." >&2
  echo "Create one: https://github.com/settings/tokens" >&2
  exit 1
fi

TMP="$(mktemp)"
HTTP_CODE="$(
  curl -sS -o "$TMP" -w "%{http_code}" -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    https://api.github.com/user/repos \
    -d '{
      "name": "aerekos-record",
      "description": "Universal ORM for Node.js — Active Record across PostgreSQL, MySQL, SQLite, MongoDB, Redis, Neo4j, Elasticsearch, Chroma",
      "private": false,
      "has_issues": true,
      "has_projects": false,
      "has_wiki": false
    }'
)"

if [[ "$HTTP_CODE" == "201" ]]; then
  echo "Created https://github.com/dallasrlones/aerekos-record"
elif [[ "$HTTP_CODE" == "422" ]] && grep -q "already exists" "$TMP" 2>/dev/null; then
  echo "Repository already exists; pushing."
elif [[ "$HTTP_CODE" == "401" ]] || [[ "$HTTP_CODE" == "403" ]]; then
  echo "GitHub returned HTTP $HTTP_CODE — check token scopes (needs ability to create repos)." >&2
  cat "$TMP" >&2
  rm -f "$TMP"
  exit 1
else
  echo "Unexpected HTTP $HTTP_CODE from GitHub API:" >&2
  cat "$TMP" >&2
  rm -f "$TMP"
  exit 1
fi
rm -f "$TMP"

git push -u origin main
echo "Done: https://github.com/dallasrlones/aerekos-record"
