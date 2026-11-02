// Collects ship positions from aisstream.io and saves them as JSON files.
// GitHub Actions runs this every 10 minutes (see .github/workflows/collect.yml).
// Each run listens for a while, writes the files every couple of minutes and
// calls `publish` (a git push) so the website can show them.
//
// Usage: node collector/collect.js <config.json> <output folder>
// Environment:
//   AISSTREAM_API_KEY  key from aisstream.io
//   RUN_MINUTES        how long to listen (default 14)
//   PUBLISH_SECONDS    how often to save + publish (default 120)
//   SIMULATE=1         don't use AIS; sail made-up ships around the course (for testing)
//   PUBLISH_CMD        shell command that publishes the output folder (git push)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Geo = require('../public/geo.js');

const [configPath = 'config.json', outDir = 'data-out'] = process.argv.slice(2);
const RUN_MS = (Number(process.env.RUN_MINUTES) || 14) * 60000;
const PUBLISH_MS = (Number(process.env.PUBLISH_SECONDS) || 120) * 1000;
const SIMULATE = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';
// Keep one track point per ship per minute (simulated ships are 20x faster, so more often).
const TRACK_STEP_MS = SIMULATE ? 5000 : 60000;
const RECENT_MS = 3 * 3600000; // live.json also carries the last 3 hours of points

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

function save() {
  const t = Date.now();
  const recent = {};
  for (const [mmsi, pts] of Object.entries(tracks)) recent[mmsi] = pts.filter((p) => p[0] >= t - RECENT_MS);
  fs.writeFileSync(tracksFile, JSON.stringify({ updated: t, ships: tracks }));
  fs.writeFileSync(liveFile, JSON.stringify({ updated: t, status, simulated: SIMULATE, simStartTime, latest, recent }));
  console.log(`${new Date(t).toISOString()} saved: ${Object.keys(latest).length} ships, ${received} new positions, status ${status}`);
  if (process.env.PUBLISH_CMD) {
    try {
      execSync(process.env.PUBLISH_CMD, { stdio: 'inherit' });
    } catch (err) {
      console.error('Publishing failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------- AIS

function connectAis() {
  const mmsis = [...fleet].filter((m) => /^\d{9}$/.test(m));
  if (!mmsis.length) {
    status = 'no ships with a valid MMSI';
    return;
  }
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.onopen = () => {
    ws.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: mmsis.slice(0, 50),
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
    }));
    status = 'live';
    console.log(`Connected to aisstream.io, listening for ${mmsis.length} ships`);
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text());
    } catch {
      return;
    }
    if (msg.error) {
      status = 'error: ' + msg.error;
      console.error('aisstream error:', msg.error);
      return;
    }
    const body = msg.Message?.[msg.MessageType];
    if (!body || !msg.MetaData) return;
    addPosition({
      mmsi: String(msg.MetaData.MMSI),
      lat: body.Latitude,
      lon: body.Longitude,
      sog: body.Sog,
      cog: body.Cog,
      hdg: body.TrueHeading === 511 ? null : body.TrueHeading,
      t: Date.now(),
    });
  };
  ws.onerror = (e) => console.error('aisstream connection error', e.message || '');
  ws.onclose = () => {
    if (finished) return;
    status = 'reconnecting';
    setTimeout(connectAis, 5000);
  };
  socket = ws;
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

// ---------------------------------------------------------------- run

let socket = null;
let finished = false;
const stopAt = SIMULATE ? now + RUN_MS : Math.min(now + RUN_MS, tracking.until);

if (SIMULATE) {
  console.log('SIMULATION mode: made-up ships, not real AIS data.');
  startSimulation();
} else {
  connectAis();
}

const timer = setInterval(save, PUBLISH_MS);
setTimeout(() => {
  finished = true;
  clearInterval(timer);
  if (socket) socket.close();
  save();
  process.exit(0);
}, Math.max(10000, stopAt - now));
