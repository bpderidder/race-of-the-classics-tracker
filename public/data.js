// Reads files from the GitHub repository.
// It first asks the GitHub API (always up to date, but each visitor can make ~60 requests
// an hour). If that limit is hit, it falls back to raw.githubusercontent.com, which has no
// limit but can be up to 5 minutes behind.
const RepoData = (() => {
  const S = window.TRACKER_SETTINGS;
  let apiBlockedUntil = 0;

  async function fetchFile(branch, file) {
    if (Date.now() > apiBlockedUntil) {
      try {
        const res = await fetch(`https://api.github.com/repos/${S.repo}/contents/${file}?ref=${branch}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
          cache: 'no-cache',
        });
        if (res.ok) return await res.json();
        if (res.status === 404) return null;
        if (res.status === 403 || res.status === 429) apiBlockedUntil = Date.now() + 15 * 60000;
      } catch {
        /* network problem: try raw below */
      }
    }
    const res = await fetch(`https://raw.githubusercontent.com/${S.repo}/${branch}/${file}?t=${Date.now()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
    return res.json();
  }

  // Big files that don't need to be fresh: skip the API to save the hourly allowance.
  async function fetchRaw(branch, file) {
    const res = await fetch(`https://raw.githubusercontent.com/${S.repo}/${branch}/${file}?t=${Date.now()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
    return res.json();
  }

  return {
    config: () => fetchRaw(S.configBranch, 'config.json'), // may be ~5 minutes behind; saves the hourly allowance
    live: () => fetchFile(S.dataBranch, 'live.json'),
    tracks: () => fetchRaw(S.dataBranch, 'tracks.json'),
  };
})();
