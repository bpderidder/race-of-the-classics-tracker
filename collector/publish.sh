#!/usr/bin/env bash
# Publishes the collected position files to the "data" branch as one fresh commit,
# so the repository doesn't grow with every update.
set -euo pipefail
cd "$1"
rm -rf .git
git init -q -b data
git add -A
git -c user.name="tracker-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "Ship positions $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q -f "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
