#!/usr/bin/env bash
set -euo pipefail

: "${SELECTED_REF:?SELECTED_REF is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

# 手动发布只允许从仓库默认分支执行。
if [[ "${SELECTED_REF}" != "${DEFAULT_BRANCH}" ]]; then
  echo "::error::Release 只能从默认分支 ${DEFAULT_BRANCH} 运行，当前为 ${SELECTED_REF}" >&2
  exit 1
fi

# 思源插件的发布版本以 plugin.json 为准。
version="$(jq -r '.version // empty' plugin.json)"

# 校验版本是否符合 X.Y.Z SemVer 格式。
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::plugin.json 中的 version 必须使用 X.Y.Z 格式" >&2
  exit 1
fi

release_tag="v${version}"

echo "release_tag=${release_tag}" >> "${GITHUB_OUTPUT}"
echo "Release tag: ${release_tag}"
