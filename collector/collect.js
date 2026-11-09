// Collects ship positions from aisstream.io and saves them as JSON files.
// GitHub Actions runs this (see .github/workflows/collect.yml). Each run queues the next one.
// Each run listens for a while, writes the files every couple of minutes and
// calls `publish` (a git push) so the website can show them.
//
// Usage: node collector/collect.js <config.json> <output folder>
// Environment:
//   AISSTREAM_API_KEY  key from aisstream.io
//   RUN_MINUTES        how long to listen (default 30)
//   PUBLISH_SECONDS    how often to publish the latest positions (default 30)
//   SIMULATE=1         don't use AIS; sail made-up ships around the course (for testing)
//   PUBLISH_CMD        shell command that publishes the output folder (git push)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Geo = require('../public/geo.js');

const [configPath = 'config.json', outDir = 'data-out'] = process.argv.slice(2);
const RUN_MS = (Number(process.env.RUN_MINUTES) || 30) * 60000;
const PUBLISH_MS = (Number(process.env.PUBLISH_SECONDS) || 30) * 1000;
// The full track history (tracks.json) is big, so it is only rewritten every 10 minutes.
// In between, live.json carries the latest positions and the last 30 minutes of each track.
const TRACKS_EVERY_MS = 10 * 60000;
const SIMULATE = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';
// Keep one track point per ship per minute (simulated ships are 20x faster, so more often).
const TRACK_STEP_MS = SIMULATE ? 5000 : 60000;
const RECENT_MS = 30 * 60000;

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tracking = config.tracking || {};
const now = Date.now();

if (!SIMULATE) {
  if (!tracking.from || !tracking.until || now < tracking.from || now > tracking.until) {
    console.log('Outside the tracking period set on the admin page. Nothing to do.');
    process.exit(0);
  }
  if (!process.env.AISSTREAM_API_KEY) {
    console.error('AISSTREAM_API_KEY secret is missing. Add it under Settings -> Secrets and variables -> Actions.');
    process.exit(1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
const tracksFile = path.join(outDir, 'tracks.json');
const liveFile = path.join(outDir, 'live.json');
const liveDir = path.join(outDir, 'live');
const LIVE_SLOT_MS = 30000; // must match LIVE_SLOT_MS in public/data.js

// Load what earlier runs collected. Points from before the tracking period are dropped.
const keepFrom = SIMULATE ? 0 : tracking.from;
let tracks = {};
let latest = {};
try {
  tracks = JSON.parse(fs.readFileSync(tracksFile, 'utf8')).ships || {};
  latest = JSON.parse(fs.readFileSync(liveFile, 'utf8')).latest || {};
} catch {
  /* first run */
}
if (SIMULATE) { tracks = {}; latest = {}; } // every simulation starts fresh
const fleet = new Set(config.fleet.map((b) => b.mmsi));
for (const mmsi of Object.keys(tracks)) {
  tracks[mmsi] = tracks[mmsi].filter((p) => p[0] >= keepFrom);
  if (!fleet.has(mmsi)) delete tracks[mmsi];
}
for (const mmsi of Object.keys(latest)) if (!fleet.has(mmsi) || latest[mmsi].t < keepFrom) delete latest[mmsi];

let status = 'starting';
let messages = 0; // everything aisstream sent us, including ships not in the fleet
let feedCheck = null; // result of the check at the start of each run
// A simulated race starts one minute after the run begins, whatever start time is set.
const simStartTime = SIMULATE ? now + 60000 : null;
let received = 0;

function addPosition(p) {
  if (!fleet.has(p.mmsi)) return;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
  const prev = latest[p.mmsi];
  if (prev && p.t <= prev.t) return;
  received++;
  latest[p.mmsi] = {
    t: p.t,
    lat: +p.lat.toFixed(5),
    lon: +p.lon.toFixed(5),
    sog: p.sog ?? null,
    cog: p.cog ?? null,
    hdg: p.hdg ?? null,
  };
  const tr = (tracks[p.mmsi] ||= []);
  const last = tr[tr.length - 1];
  if (!last || p.t - last[0] >= TRACK_STEP_MS) tr.push([p.t, +p.lat.toFixed(5), +p.lon.toFixed(5)]);
}

let tracksSavedAt = 0;
function save(final = false) {
  const t = Date.now();
  const recent = {};
  for (const [mmsi, pts] of Object.entries(tracks)) recent[mmsi] = pts.filter((p) => p[0] >= t - RECENT_MS);
  if (final || t - tracksSavedAt >= TRACKS_EVERY_MS) {
    fs.writeFileSync(tracksFile, JSON.stringify({ updated: t, ships: tracks }));
    tracksSavedAt = t;
  }
  const liveJson = JSON.stringify({ updated: t, status, simulated: SIMULATE, simStartTime, messages, fleetFoundBy, feedCheck, latest, recent });
  fs.writeFileSync(liveFile, liveJson);
  // Also save it under a name that changes every 30 seconds (live/<number>.json). GitHub caches
  // files for 5 minutes, but a new file name is always fetched fresh, so the website can read
  // the newest one without using GitHub's limited API. Only the last few are kept.
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, `${Math.floor(t / LIVE_SLOT_MS)}.json`), liveJson);
  for (const f of fs.readdirSync(liveDir)) {
    if (Number(f.split('.')[0]) < Math.floor(t / LIVE_SLOT_MS) - 12) fs.rmSync(path.join(liveDir, f));
  }
  console.log(`${new Date(t).toISOString()} saved: ${Object.keys(latest).length} ships, ${received} new positions from the fleet (area ${fleetFoundBy.area}, world ${fleetFoundBy.world}), ${messages} messages from all ships in the area, status ${status}`);
  if (process.env.PUBLISH_CMD) {
    try {
      execSync(process.env.PUBLISH_CMD, { stdio: 'inherit' });
    } catch (err) {
      console.error('Publishing failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------- AIS

async function parseMessage(ev) {
  try {
    return JSON.parse(typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text());
  } catch {
    return null;
  }
}

// The area we listen to: the course plus a wide margin (about 180 nm north-south and
// 270 nm east-west), so ships still show up on their way to the start or home.
// Without a course, the North Sea and Dutch coast.
function listenArea(marginLat = 3, marginLon = 4.5) {
  const course = config.courses.find((c) => c.id === config.activeCourseId);
  const pts = (course?.marks || []).flatMap((m) => m.points);
  if (!pts.length) return [[50, -4], [60, 10]];
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  return [[Math.min(...lats) - marginLat, Math.min(...lons) - marginLon], [Math.max(...lats) + marginLat, Math.max(...lons) + marginLon]];
}

// Listens to every ship in the race area for a short while. This shows in the log whether
// the AIS feed works at all, which helps when the fleet's own ships don't show up.
function runFeedCheck(seconds = 30) {
  const box = listenArea(1, 1.5);
  return new Promise((resolve) => {
    const seen = new Set();
    let count = 0;
    let error = null;
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    const done = () => {
      ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
      feedCheck = { at: Date.now(), seconds, area: box, positions: count, shipsSeen: seen.size, error };
      console.log(`Feed check: ${count} position reports from ${seen.size} ships in the race area in ${seconds}s${error ? ', error: ' + error : ''}`);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: [box],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
    }));
    ws.onmessage = async (ev) => {
      const msg = await parseMessage(ev);
      if (msg?.error) error = msg.error;
      if (msg?.MetaData) { count++; seen.add(msg.MetaData.MMSI); }
    };
    ws.onerror = (e) => { error = e.message || 'connection error'; };
    ws.onclose = () => { clearTimeout(timer); done(); };
  });
}

// Two connections run side by side, so a ship is found wherever aisstream hears it:
//  - "area":  every ship around the course; we pick out the fleet ourselves
//  - "world": only the fleet's MMSIs, anywhere in the world (e.g. a ship abroad or on its way)
const fleetFoundBy = { area: 0, world: 0 }; // fleet positions received per connection

function connectAis() {
  const mmsis = [...fleet].filter((m) => /^\d{9}$/.test(m));
  if (!mmsis.length) {
    status = 'no ships with a valid MMSI';
    return;
  }
  openAisStream('area', { BoundingBoxes: [listenArea()] });
  openAisStream('world', { BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: mmsis.slice(0, 50) });
}

function openAisStream(name, filter) {
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  sockets[name] = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      ...filter,
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
    }));
    status = 'live';
    console.log(`Connected to aisstream.io (${name}): ${JSON.stringify(filter).slice(0, 200)}`);
  };
  ws.onmessage = async (ev) => {
    const msg = await parseMessage(ev);
    if (!msg) return;
    if (name === 'area') messages++;
    if (msg.error) {
      status = 'error: ' + msg.error;
      console.error(`aisstream error (${name}):`, msg.error);
      return;
    }
    const body = msg.Message?.[msg.MessageType];
    if (!body || !msg.MetaData) return;
    const mmsi = String(msg.MetaData.MMSI);
    if (!fleet.has(mmsi)) return;
    fleetFoundBy[name]++;
    if (!latest[mmsi]) console.log(`First position from ${msg.MetaData.ShipName?.trim() || mmsi} (${mmsi}) via ${name}`);
    addPosition({
      mmsi,
      lat: body.Latitude,
      lon: body.Longitude,
      sog: body.Sog,
      cog: body.Cog,
      hdg: body.TrueHeading === 511 ? null : body.TrueHeading,
      t: Date.now(),
    });
  };
  ws.onerror = (e) => console.error(`aisstream connection error (${name})`, e.message || '');
  ws.onclose = () => {
    if (finished) return;
    status = 'reconnecting';
    setTimeout(() => openAisStream(name, filter), 5000);
  };
}

// ---------------------------------------------------------------- simulation (testing only)

function startSimulation() {
  status = 'live';
  const course = config.courses.find((c) => c.id === config.activeCourseId);
  const marks = course?.marks || [];
  if (marks.length < 2) {
    status = 'simulation needs a course with at least a start and a finish';
    return;
  }
  const speedup = Number(process.env.SIMULATE_SPEEDUP) || 20;
  const start = marks[0];
  const toFirst = Geo.bearing(Geo.markCenter(start), Geo.markCenter(marks[1]));
  const raceStart = simStartTime;
  const sims = config.fleet.map((b, i) => {
    const p0 = start.points[0];
    const p1 = start.points[1] || p0;
    const f = (i + 1) / (config.fleet.length + 1);
    const onLine = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
    return { mmsi: b.mmsi, pos: Geo.destination(onLine, toFirst + 180, 0.15), next: 1, speed: 5 + Math.random() * 3, phase: Math.random() * 10, done: false };
  });
  let lastT = Date.now();
  setInterval(() => {
    const t = Date.now();
    const dtH = ((t - lastT) / 3600000) * speedup;
    lastT = t;
    for (const s of sims) {
      let cog = toFirst;
      let sog = 0.5;
      if (t >= raceStart && !s.done) {
        const target = Geo.markCenter(marks[s.next]);
        cog = (Geo.bearing(s.pos, target) + 12 * Math.sin(t / 9000 + s.phase) + 360) % 360;
        sog = s.speed * (0.85 + 0.15 * Math.sin(t / 13000 + s.phase));
        const step = sog * dtH;
        if (Geo.distNm(s.pos, target) <= step) {
          s.pos = target;
          if (s.next === marks.length - 1) s.done = true;
          else s.next++;
        } else {
          s.pos = Geo.destination(s.pos, cog, step);
        }
      }
      if (s.done) sog = 0;
      addPosition({ mmsi: s.mmsi, lat: s.pos[0], lon: s.pos[1], sog: +sog.toFixed(1), cog: Math.round(cog), hdg: null, t });
    }
  }, 3000);
}

// ---------------------------------------------------------------- keep collecting

// Queue the next run straight away. GitHub starts it as soon as this one ends, so collecting
// doesn't depend on GitHub's timetable (which can be late or not run at all).
async function queueNextRun() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/collect.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main' }),
    });
    console.log(res.ok ? 'Next run queued.' : `Could not queue the next run (HTTP ${res.status}); the 10-minute schedule is the backup.`);
  } catch (err) {
    console.error('Could not queue the next run:', err.message);
  }
}

// ---------------------------------------------------------------- run

const sockets = {};
let finished = false;
const stopAt = SIMULATE ? now + RUN_MS : Math.min(now + RUN_MS, tracking.until);

if (SIMULATE) {
  console.log('SIMULATION mode: made-up ships, not real AIS data.');
  startSimulation();
} else {
  if (stopAt < tracking.until) queueNextRun();
  runFeedCheck().then(() => { if (!finished) connectAis(); });
}

const timer = setInterval(save, PUBLISH_MS);
setTimeout(() => {
  finished = true;
  clearInterval(timer);
  for (const ws of Object.values(sockets)) ws.close();
  save(true);
  process.exit(0);
}, Math.max(10000, stopAt - now));
