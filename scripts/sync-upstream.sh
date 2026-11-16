#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your changes before syncing upstream." >&2
  exit 1
fi

git fetch https://github.com/pingdotgg/t3code.git main
git merge --no-edit FETCH_HEAD
printf '\nUpstream merge result: '
git log -1 --oneline
