#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_API_URL:?GITHUB_API_URL is required}"

release_response="$(mktemp)"
tag_response="$(mktemp)"

trap 'rm -f "$release_response" "$tag_response"' EXIT

request_status() {
  local output_file="$1"
  local endpoint="$2"

  curl \
    --silent \
    --show-error \
    --location \
    --header "Accept: application/vnd.github+json" \
    --header "Authorization: Bearer ${GH_TOKEN}" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    --write-out '%{http_code}' \
    --output "${output_file}" \
    "${GITHUB_API_URL}/repos/${GH_REPO}/${endpoint}"
}

# 查询同名 GitHub Release。
release_status="$(
  request_status \
    "${release_response}" \
    "releases/tags/${RELEASE_TAG}"
)"

case "${release_status}" in
  200)
    release_exists=true
    ;;
  404)
    release_exists=false
    ;;
  *)
    echo "::error::查询 ${RELEASE_TAG} Release 失败（HTTP ${release_status}）" >&2
    exit 1
    ;;
esac

# 查询同名 Git Tag。
tag_status="$(
  request_status \
    "${tag_response}" \
    "git/ref/tags/${RELEASE_TAG}"
)"

case "${tag_status}" in
  200)
    object_type="$(jq -r '.object.type' "${tag_response}")"
    object_sha="$(jq -r '.object.sha' "${tag_response}")"

    # 兼容 annotated tag，逐层解析到最终 commit。
    while [[ "${object_type}" == "tag" ]]; do
      tag_object_status="$(
        request_status \
          "${tag_response}" \
          "git/tags/${object_sha}"
      )"

      if [[ "${tag_object_status}" != "200" ]]; then
        echo "::error::解析 ${RELEASE_TAG} Tag 失败（HTTP ${tag_object_status}）" >&2
        exit 1
      fi

      object_type="$(jq -r '.object.type' "${tag_response}")"
      object_sha="$(jq -r '.object.sha' "${tag_response}")"
    done

    if [[ "${object_type}" != "commit" ]]; then
      echo "::error::${RELEASE_TAG} 未指向 commit（当前类型为 ${object_type}）" >&2
      exit 1
    fi

    existing_commit="${object_sha}"
    ;;

  404)
    existing_commit=""
    ;;

  *)
    echo "::error::查询 ${RELEASE_TAG} Tag 失败（HTTP ${tag_status}）" >&2
    exit 1
    ;;
esac

# 根据 Tag 和 Release 的状态决定如何处理。
if [[ -n "${existing_commit}" && "${existing_commit}" == "${GITHUB_SHA}" ]]; then
  if [[ "${release_exists}" == "true" ]]; then
    echo "::error::${RELEASE_TAG} 已经发布且指向当前提交 ${GITHUB_SHA}" >&2
    exit 1
  fi

  echo "${RELEASE_TAG} 已指向当前提交，将复用该 Tag。"

elif [[ -n "${existing_commit}" ]]; then
  echo "${RELEASE_TAG} 指向旧提交 ${existing_commit}，将替换为 ${GITHUB_SHA}。"

  if [[ "${release_exists}" == "true" ]]; then
    # 删除旧 Release 及其关联 Tag。
    gh release delete \
      "${RELEASE_TAG}" \
      --cleanup-tag \
      --yes
  else
    # 只有 Tag，没有 Release，只删除 Tag。
    gh api \
      --method DELETE \
      "repos/${GH_REPO}/git/refs/tags/${RELEASE_TAG}"
  fi
  git tag -d "${RELEASE_TAG}" >/dev/null 2>&1 || true

elif [[ "${release_exists}" == "true" ]]; then
  echo "::error::${RELEASE_TAG} Release 存在，但找不到对应 Tag" >&2
  exit 1
fi

echo "Tag reconciliation completed: ${RELEASE_TAG}"
