#!/usr/bin/env bash
set -euo pipefail

# worktree を origin/production の最新を起点に作る。
# 使い方: bash scripts/new-worktree.sh <branch-name> [worktree-dir]
# 例:     bash scripts/new-worktree.sh feat-foo
# 例:     bash scripts/new-worktree.sh feat-foo ../feat-foo

BRANCH_NAME="${1:-}"

if [[ -z "$BRANCH_NAME" ]]; then
  echo "Usage: bash scripts/new-worktree.sh <branch-name> [worktree-dir]" >&2
  exit 1
fi

WORKTREE_DIR="${2:-../${BRANCH_NAME}}"

git fetch origin production

if git rev-parse --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Error: branch ${BRANCH_NAME} already exists" >&2
  exit 1
fi

if [[ -e "$WORKTREE_DIR" ]]; then
  echo "Error: ${WORKTREE_DIR} already exists" >&2
  exit 1
fi

# -b は明示しつつ、起点は origin/production とする
git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" origin/production

echo "Created ${WORKTREE_DIR} on ${BRANCH_NAME} from origin/production"
