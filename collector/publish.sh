#!/usr/bin/env bash
# Publishes the files in the given folder to the "data" branch as a single commit that
# replaces the previous one, so the repository doesn't grow with every update.
# Files that didn't change since the last publish aren't uploaded again.
set -euo pipefail
cd "$1"
remote="${PUBLISH_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$remote"
  # Knowing what's already on GitHub lets git skip re-uploading unchanged files
  git fetch -q --depth 1 origin data 2>/dev/null || true
fi
git add -A
tree=$(git write-tree)
commit=$(git -c user.name="tracker-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit-tree "$tree" -m "Ship positions $(date -u +%Y-%m-%dT%H:%M:%SZ)")
git push -q -f origin "$commit:refs/heads/data"
git update-ref refs/remotes/origin/data "$commit"
