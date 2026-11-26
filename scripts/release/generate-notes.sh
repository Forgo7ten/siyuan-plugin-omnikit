#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

api_url="${GITHUB_API_URL:-https://api.github.com}"
output_file="${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/release-notes-${RELEASE_TAG}.md}"

response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

prev_tag="$(
  git tag --merged HEAD --list 'v*' --sort=-v:refname \
    | grep -Fxv "${RELEASE_TAG}" \
    | head -n 1 \
    || true
)"

if [[ -n "${prev_tag}" ]]; then
  payload="$(
    jq -n \
      --arg tag "${RELEASE_TAG}" \
      --arg sha "${GITHUB_SHA}" \
      --arg prev "${prev_tag}" \
      '{ tag_name: $tag, target_commitish: $sha, previous_tag_name: $prev }'
  )"
  commits="$(git log "${prev_tag}..HEAD" --no-merges --pretty=format:'- %s')"
else
  payload="$(
    jq -n \
      --arg tag "${RELEASE_TAG}" \
      --arg sha "${GITHUB_SHA}" \
      '{ tag_name: $tag, target_commitish: $sha }'
  )"
  commits="$(git log HEAD --no-merges --pretty=format:'- %s')"
fi

http_status="$(
  curl \
    --silent \
    --show-error \
    --location \
    --request POST \
    --header "Accept: application/vnd.github+json" \
    --header "Authorization: Bearer ${GH_TOKEN}" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    --header "Content-Type: application/json" \
    --data "${payload}" \
    --write-out '%{http_code}' \
    --output "${response_file}" \
    "${api_url}/repos/${GH_REPO}/releases/generate-notes"
)"

if [[ "${http_status}" != "200" ]]; then
  echo "::error::调用 GitHub releases/generate-notes 失败（HTTP ${http_status}）" >&2
  cat "${response_file}" >&2 || true
  exit 1
fi

github_body="$(jq -r '.body // ""' "${response_file}")"

{
  if [[ -n "${github_body}" ]]; then
    printf '%s\n' "${github_body}"
  fi
  if [[ -n "${commits}" ]]; then
    if [[ -n "${github_body}" ]]; then
      printf '\n'
    fi
    printf '## Commits\n\n%s\n' "${commits}"
  fi
} > "${output_file}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "notes_file=${output_file}" >> "${GITHUB_OUTPUT}"
fi

echo "Generated release notes: ${output_file} (prev_tag=${prev_tag:-none})"
