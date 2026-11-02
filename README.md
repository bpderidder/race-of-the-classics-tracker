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
| `DATABASE_URL` | Connection string of a Postgres database, such as a free [Neon](https://neon.com) database. Ships, courses and tracks are saved there. |
| `DATA_DIR` | Only used without `DATABASE_URL`: the folder where everything is saved as files. |

---

## Putting it online for free (Hugging Face + Neon, no credit card)

**1. Database (Neon)**
1. Sign up at [neon.com](https://neon.com) (free plan) and create a project. Pick the region closest to the
   Netherlands (Frankfurt).
2. Click **Connect** and copy the connection string. It starts with `postgresql://`. This is your `DATABASE_URL`.

Neon pauses a free project after about a week without use. If that happens, open the Neon dashboard and
it starts again. Your data is kept.

**2. Website (Hugging Face Spaces)**
1. Sign up at [huggingface.co](https://huggingface.co) and click **New → Space**.
2. Give it a name, choose **Docker** as the SDK with the **Blank** template, the free **CPU basic**
   hardware, and **Public** visibility. Then click **Create Space**.
3. In the Space, open **Files → + Contribute → Create a new file**. Name it `Dockerfile` and paste
   the contents of [`deploy/huggingface/Dockerfile`](deploy/huggingface/Dockerfile). Commit it.
4. Open **Settings → Variables and secrets** and add three **secrets**: `AISSTREAM_API_KEY`,
   `ADMIN_PASSWORD` and `DATABASE_URL`.
5. The Space builds and starts. Your public link is `https://<your-username>-<space-name>.hf.space`,
   and the admin page is that link plus `/admin`.

A free Space goes to sleep after 48 hours without visitors, and it wakes up again when someone opens the link.
During a race people keep looking, so it stays awake. Open the link a day before the race to be safe.

**Updating:** after the code on GitHub changes, open the Space's **Settings** and click
**Factory rebuild**.

### Other hosts
Any host that runs Node.js works too, for example Railway or a VPS. The start command is `npm start`.
Either set `DATABASE_URL`, or give it a persistent disk and point `DATA_DIR` at it.

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
| `server.js` | Connects to the AIS feed, works out standings, serves the website. Also runs the demo simulation. |
| `storage.js` | Saves settings and tracks, to the database or to files. |
| `deploy/huggingface/Dockerfile` | Setup file for hosting on Hugging Face Spaces. |
| `public/index.html`, `app.js`, `style.css` | The public map page. |
| `public/admin.html`, `admin.js`, `admin.css` | The admin page. |
| `public/common.js` | Map drawing shared by both pages. |
| `public/geo.js` | Distance and course maths, plus the standard course templates. |
