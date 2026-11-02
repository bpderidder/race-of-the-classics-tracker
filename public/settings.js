// Where the tracker reads its settings and ship positions from.
// If you move the repository or rename it, change `repo` here.
window.TRACKER_SETTINGS = {
  repo: 'bpderidder/race-of-the-classics-tracker',
  configBranch: 'main', // config.json (ships, courses, race times) lives here
  dataBranch: 'data', // positions collected by GitHub Actions live here
};
