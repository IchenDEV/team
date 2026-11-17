#!/usr/bin/env bash
set -euo pipefail

# The contract is 0 for success, 2 for a blocked candidate and 1 for any other
# error; unexpected command failures must not leak their own exit codes.
scratch=
trap 'rc=$?; if [[ -n "$scratch" ]]; then rm -rf -- "$scratch"; fi; if [[ "$rc" != 0 && "$rc" != 2 ]]; then exit 1; fi' EXIT

cd -- "$(dirname -- "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your changes before syncing upstream." >&2
  exit 1
fi

# Local URLs let the fixture exercise the real Git path without GitHub.
git fetch --no-tags origin main
base=$(git rev-parse FETCH_HEAD)
git fetch --no-tags "${SYNC_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}" main
upstream=$(git rev-parse FETCH_HEAD)
output() {
  printf '%s=%s\n' "$1" "$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}
output base "$base"
output upstream "$upstream"
if git merge-base --is-ancestor "$upstream" "$base"; then
  output status no-update
  exit 0
fi
git merge-base "$base" "$upstream" > /dev/null

scratch=$(mktemp -d)
status=clean
merge_exit=0
git merge-tree --write-tree "$base" "$upstream" > "$scratch/merge" || merge_exit=$?
if [[ "$merge_exit" -gt 1 ]]; then
  cat "$scratch/merge" >&2
  exit "$merge_exit"
fi
tree=$(head -n 1 "$scratch/merge")
if [[ "$merge_exit" == 1 ]] || ! git diff --quiet "$base" "$tree" -- LICENSE; then
  status=blocked
  {
    printf '# Upstream integration blocked\n\nBase: `%s`\n\nUpstream: `%s`\n\n' "$base" "$upstream"
    printf 'Resolve conflicts or license changes manually. This candidate keeps the fork tree unchanged.\n\n```text\n'
    cat "$scratch/merge"
    printf '\n```\n'
  } > "$scratch/blocked.md"
  GIT_INDEX_FILE="$scratch/index" git read-tree "$base"
  blob=$(git hash-object -w "$scratch/blocked.md")
  GIT_INDEX_FILE="$scratch/index" git update-index --add --cacheinfo "100644,$blob,UPSTREAM_SYNC_BLOCKED.md"
  tree=$(GIT_INDEX_FILE="$scratch/index" git write-tree)
  parents=(-p "$base")
else
  parents=(-p "$base" -p "$upstream")
fi

branch="sync/upstream-$base-$upstream"
head=$(printf 'Integrate upstream %s (%s)\n' "$upstream" "$status" | git commit-tree "$tree" "${parents[@]}")
# Immutable candidates never overwrite manual edits or rewrite a published branch.
if git show-ref --verify --quiet "refs/heads/$branch"; then
  existing=$(git rev-parse "refs/heads/$branch")
  expected_parents="$base"
  if [[ "$status" == clean ]]; then expected_parents="$base $upstream"; fi
  if [[ "$(git show -s --format=%T "$existing")" != "$tree" ]] ||
    [[ "$(git show -s --format=%P "$existing")" != "$expected_parents" ]]; then
    echo "Candidate branch already exists with different content or parents: $branch" >&2
    exit 1
  fi
  head=$existing
else
  git update-ref "refs/heads/$branch" "$head" ""
fi
output status "$status"
output branch "$branch"
output head "$head"
if [[ "$status" == blocked ]]; then
  echo "Integration blocked; main and the current checkout are unchanged." >&2
  exit 2
fi
