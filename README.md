# Race of the Classics – Live Tracker

A live map of the fleet during the race. It reads each ship's position from its
AIS transponder, so nothing has to be installed on board.

- **Public page** (`/`): live map with boats, tracks, the course, and live standings. Share this link.
- **Admin page** (`/admin`): password protected. Add ships, draw courses, set the start time.

You never need to edit code to run a race. Everything is done from the admin page.

---

## Running a race (admin page)

1. **Ships tab:** add every ship with its name, team and **MMSI**. The MMSI is a 9-digit
   number, which you can find by searching the ship's name on
   [MarineTraffic](https://www.marinetraffic.com) or [VesselFinder](https://www.vesselfinder.com).
2. **Courses tab:**
   - Click **+ New** to start a course.
   - Open **Quick start**, choose *windward–leeward*, *triangle* or *point to point*,
     enter the wind direction and leg length, then click the map where the start should be.
   - Drag any mark on the map to fine-tune it. Rename marks and choose which side they are
     left on (port/starboard).
   - Or build a course by hand with **+ Add mark** and **+ Add line**. The first item is
     always the start and the last item is always the finish.
   - Click **Use this course for the race**.
3. **Race tab:** set the start time and the page title.
4. Click **Save** (top right). The public page updates immediately.

Before a new race, use **Race → Clear all tracks** to remove the old tracks.

### How standings work
After the start, each ship has to reach each mark in order. A mark counts as reached
when the ship comes within the *mark rounding distance* (Race tab, 0.15 nm by default)
or crosses a line. Ships are ranked by distance still to sail along the course, and
finished ships by finish time.

### About AIS coverage
Positions come from land-based AIS receivers that reach about 20–40 nm offshore. Further
out a ship can go quiet for a while. The standings show how old each position is, and
the ship's marker turns faded after 15 minutes without an update.

---

## Settings (environment variables)

These are set on the hosting platform, not in the code.

| Name | What it is |
|---|---|
| `AISSTREAM_API_KEY` | Free key from [aisstream.io](https://aisstream.io) (sign in with GitHub, then "API Keys"). **Without it the tracker runs in demo mode with simulated ships.** |
| `ADMIN_PASSWORD` | Password for the admin page. Choose a strong one. |
| `DATA_DIR` | Folder where ships, courses and tracks are saved. On the host this must be a *persistent volume* (see below). |

---

## Putting it online

The tracker has to run all the time during the race to keep collecting positions, so it
needs a host with an "always on" server and a disk that keeps files. A good, easy option is
**[Railway](https://railway.app)**, which costs about $5 a month and can be paused between races:

1. Put this folder in a GitHub repository.
2. On Railway: **New Project → Deploy from GitHub repo**, then pick the repository.
3. Under **Variables**, add `AISSTREAM_API_KEY`, `ADMIN_PASSWORD`, and `DATA_DIR` = `/data`.
4. Add a **Volume** to the service, mounted at `/data`.
5. Under **Settings → Networking**, click **Generate Domain**. That's your public link.
   You can also connect your own domain there.

Other hosts that run Node.js with a persistent disk (Render with a paid disk, Fly.io, a VPS)
work too. The start command is `npm start`.

---

## Trying it on your own computer

You need [Node.js](https://nodejs.org) (version 18 or newer). In this folder run:

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000. The admin page is at http://localhost:3000/admin, and the
password is `changeme` unless you set `ADMIN_PASSWORD`.

## Files

| File | What it does |
|---|---|
| `server.js` | Connects to the AIS feed, saves positions, works out standings, serves the website. Also runs the demo simulation. |
| `public/index.html`, `app.js`, `style.css` | The public map page. |
| `public/admin.html`, `admin.js`, `admin.css` | The admin page. |
| `public/common.js` | Map drawing shared by both pages. |
| `public/geo.js` | Distance and course maths, plus the standard course templates. |
