# Race of the Classics – Live Tracker

A live map of the fleet during the race. It reads each ship's position from its
AIS transponder, so nothing has to be installed on board.

Everything runs on GitHub, for free:

- **GitHub Pages** hosts the website.
- **GitHub Actions** collects ship positions from [aisstream.io](https://aisstream.io) during the
  tracking period and saves them in this repository (the `data` branch) about every 2 minutes.
- The **admin page** saves your ships, courses and race times to `config.json` in this repository.

Pages:
- **Public page:** `https://bpderidder.github.io/race-of-the-classics-tracker/`. Share this link.
- **Admin page:** `https://bpderidder.github.io/race-of-the-classics-tracker/admin.html`

You never need to edit code to run a race.

---

## One-time setup

### 1. Turn on the website
Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Then go to **Actions → Publish website → Run workflow**. After a minute the site is live.

### 2. Add the AIS key
Repository **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `AISSTREAM_API_KEY`
- Secret: your key from aisstream.io

### 3. Make a GitHub key for the admin page
The admin page saves changes straight to this repository, so it needs a key that is allowed to do that.

1. On GitHub: your profile picture → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Name: `tracker admin`. Expiration: for example 1 year.
3. **Repository access → Only select repositories →** `race-of-the-classics-tracker`.
4. **Permissions → Repository permissions → Contents → Read and write**.
5. **Generate token** and copy it. It starts with `github_pat_`.
6. Paste it on the admin page to log in. Your browser remembers it on that device.

Treat this key like a password. Anyone who has it can change the repository.
If it leaks, delete it on the same GitHub page and make a new one.

---

## Running a race (admin page)

1. **Ships tab:** add every ship with its name, team and **MMSI**. The MMSI is a 9-digit
   number, which you can find by searching the ship's name on
   [MarineTraffic](https://www.marinetraffic.com) or [VesselFinder](https://www.vesselfinder.com).
2. **Courses tab:**
   - Click **+ New** to start a course.
   - Open **Quick start**, choose *windward–leeward*, *triangle* or *point to point*,
     enter the wind direction and leg length, then click the map where the start should be.
   - Drag marks on the map to fine-tune them. Rename marks and choose which side they are
     left on (port/starboard).
   - Or build a course by hand with **+ Add mark** and **+ Add line**. The first item is
     always the start and the last item is always the finish.
   - Click **Use this course for the race**.
3. **Race tab:**
   - Set the **start time**.
   - Set the **tracking period**, for example from the day before the start until a few
     days after. Positions are only collected during this period.
4. Click **Save** (top right). The public page picks up the changes within a few minutes.

### Before every race
- **Check that the position collector is switched on.** GitHub switches off scheduled jobs in a
  repository that has had no changes for 60 days. Go to **Actions → Collect ship positions**.
  If you see a message that it is disabled, click **Enable workflow**.
- **Do a test run.** Go to **Actions → Collect ship positions → Run workflow**, tick
  *Test run with made-up ships* and click **Run workflow**. For about 15 minutes the public page
  shows made-up ships sailing the course in use, marked "Test – simulated ships".

### How standings work
After the start, each ship has to reach each mark in order. A mark counts as reached
when the ship's track passes within the *mark rounding distance* (Race tab, 0.15 nm by
default) or crosses a line. Ships are ranked by distance still to sail along the course, and
finished ships by finish time.

### Things to know
- **Updates every ~2 minutes.** Positions are published about every 2 minutes and the page checks for
  new data every 2 minutes, so the map runs a few minutes behind real time. Ships keep
  one track point per minute.
- **AIS coverage.** Positions come from land-based AIS receivers that reach about 20–40 nm offshore.
  Further out a ship can go quiet for a while. The standings show how old each position is,
  and the ship's marker fades after 15 minutes without an update.
- **GitHub's rules.** GitHub Actions is meant for building and publishing a project. This
  tracker only runs during the tracking period you set, so its use is light, but keep the
  period to the race days.
- **Up to 50 ships** can be tracked at once, the limit of the AIS service.

---

## Putting it on another website

Add this where the tracker should appear on your existing site:

```html
<iframe src="https://bpderidder.github.io/race-of-the-classics-tracker/"
        style="width:100%; height:80vh; border:0;" title="Live race tracker"></iframe>
```

Most website builders (WordPress, Wix, Squarespace) have an "Embed" or "HTML" block for this.

---

## Files

| File | What it does |
|---|---|
| `config.json` | Ships, courses and race times. Written by the admin page. |
| `public/` | The website: `index.html` (public map) and `admin.html` (admin page). |
| `public/settings.js` | Name of this repository. Change it if the repository moves. |
| `public/race.js` | Works out the standings. |
| `public/geo.js` | Distance and course maths, plus the standard course templates. |
| `collector/collect.js` | Collects positions from aisstream.io (run by GitHub Actions). |
| `.github/workflows/collect.yml` | Runs the collector every 10 minutes. |
| `.github/workflows/pages.yml` | Publishes the website when `public/` changes. |
