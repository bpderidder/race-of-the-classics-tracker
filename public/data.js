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

  // The collector saves the latest positions every 30 seconds under a new name,
  // live/<number>.json, where the number counts 30-second steps since 1970. A file name that
  // didn't exist before is always fetched fresh, so we ask for the newest one that should
  // exist by now, and step back if it isn't there yet. No API allowance is used.
  const LIVE_SLOT_MS = 30000; // must match LIVE_SLOT_MS in collector/collect.js
  let lastSlot = 0;
  async function fetchLive() {
    const newest = Math.floor((Date.now() - 45000) / LIVE_SLOT_MS);
    for (let slot = newest; slot >= newest - 10 && slot > lastSlot; slot--) {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${S.repo}/${S.dataBranch}/live/${slot}.json`);
        if (res.ok) {
          lastSlot = slot;
          return res.json();
        }
      } catch {
        /* try the one before */
      }
    }
    if (lastSlot) return null; // nothing newer than what the page already shows
    // Nothing found (collector not running, or this device's clock is far off)
    return fetchFile(S.dataBranch, 'live.json');
  }

  return {
    config: () => fetchRaw(S.configBranch, 'config.json'), // may be ~5 minutes behind; saves the hourly allowance
    live: fetchLive,
    tracks: () => fetchRaw(S.dataBranch, 'tracks.json'),
  };
})();
