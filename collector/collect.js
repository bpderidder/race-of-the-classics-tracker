// Collects ship positions and saves them as JSON files on the "data" branch.
// Two sources, both optional:
//   - phones (the OwnTracks app), received by the Google script in phone-tracking/Code.gs
//   - AIS from aisstream.io
// GitHub Actions runs this (see .github/workflows/collect.yml). Each run collects for a
// while, writes the files every couple of minutes and calls PUBLISH_CMD (a git push).
//
// Usage: node collector/collect.js <config.json> <output folder>
// Environment:
//   AISSTREAM_API_KEY  key from aisstream.io (optional)
//   RUN_MINUTES        how long to collect (default 30)
//   PUBLISH_SECONDS    how often to save + publish (default 120)
//   SIMULATE=1         no real data; sail made-up ships around the course (for testing)
//   PUBLISH_CMD        shell command that publishes the output folder (git push)
//   GITHUB_TOKEN, GITHUB_REPOSITORY  used to queue the next run, so collecting never stops

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Geo = require('../public/geo.js');

const [configPath = 'config.json', outDir = 'data-out'] = process.argv.slice(2);
const RUN_MS = (Number(process.env.RUN_MINUTES) || 30) * 60000;
const PUBLISH_MS = (Number(process.env.PUBLISH_SECONDS) || 120) * 1000;
const PHONE_POLL_MS = 30000;
const SIMULATE = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';
// Keep one track point per ship per minute (simulated ships are 20x faster, so more often).
const TRACK_STEP_MS = SIMULATE ? 5000 : 60000;
const RECENT_MS = 3 * 3600000; // live.json also carries the last 3 hours of points

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tracking = config.tracking || {};
const phoneUrl = (config.phoneTracking?.url || '').trim();
const aisKey = (process.env.AISSTREAM_API_KEY || '').trim();
const now = Date.now();

if (!SIMULATE) {
  if (!tracking.from || !tracking.until || now < tracking.from || now > tracking.until) {
    console.log('Outside the tracking period set on the admin page. Nothing to do.');
    process.exit(0);
  }
  if (!aisKey && !phoneUrl) {
    console.error('No position source: add the AISSTREAM_API_KEY secret and/or set up phone tracking on the admin page.');
    process.exit(1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
const tracksFile = path.join(outDir, 'tracks.json');
const liveFile = path.join(outDir, 'live.json');

// Ships are identified by their id from config.json. AIS reports are matched by MMSI.
const fleetIds = new Set(config.fleet.map((b) => b.id));
const idByMmsi = new Map(config.fleet.filter((b) => /^\d{9}$/.test(b.mmsi)).map((b) => [b.mmsi, b.id]));

// Load what earlier runs collected. Points from before the tracking period are dropped.
const keepFrom = SIMULATE ? 0 : tracking.from;
let tracks = {};
let latest = {};
let phoneRow = 2; // next row to read from the phone positions sheet
try {
  tracks = JSON.parse(fs.readFileSync(tracksFile, 'utf8')).ships || {};
  const live = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
  latest = live.latest || {};
  if (live.phoneUrl === phoneUrl && live.phoneRow) phoneRow = live.phoneRow;
} catch {
  /* first run */
}
if (SIMULATE) { tracks = {}; latest = {}; } // every simulation starts fresh
for (const id of Object.keys(tracks)) {
  tracks[id] = tracks[id].filter((p) => p[0] >= keepFrom);
  if (!fleetIds.has(id)) delete tracks[id];
}
for (const id of Object.keys(latest)) if (!fleetIds.has(id) || latest[id].t < keepFrom) delete latest[id];

const sources = {
  ais: SIMULATE ? 'off' : aisKey ? 'starting' : 'off',
  phones: SIMULATE ? 'off' : phoneUrl ? 'starting' : 'off',
};
let aisMessages = 0; // everything aisstream sent us, including ships not in the fleet
let feedCheck = null; // result of the AIS check at the start of each run
const received = { ais: 0, phones: 0 };
// A simulated race starts one minute after the run begins, whatever start time is set.
const simStartTime = SIMULATE ? now + 60000 : null;

// Adds a position. Positions may arrive late (a phone that was out of signal sends
// its stored positions afterwards), so track points are put in the right place in time.
function addPosition(p) {
  if (!fleetIds.has(p.id) || p.t < keepFrom) return;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
  if (p.t > Date.now() + 5 * 60000) return; // clock far in the future: ignore
  const lat = +p.lat.toFixed(5);
  const lon = +p.lon.toFixed(5);
  const prev = latest[p.id];
  if (!prev || p.t > prev.t) {
    latest[p.id] = { t: p.t, lat, lon, sog: p.sog ?? null, cog: p.cog ?? null, hdg: p.hdg ?? null, src: p.src, batt: p.batt ?? null };
  }
  const tr = (tracks[p.id] ||= []);
  let i = tr.length;
  while (i > 0 && tr[i - 1][0] > p.t) i--;
  const before = tr[i - 1];
  const after = tr[i];
  if ((!before || p.t - before[0] >= TRACK_STEP_MS) && (!after || after[0] - p.t >= TRACK_STEP_MS)) {
    tr.splice(i, 0, [p.t, lat, lon]);
  }
}

function overallStatus() {
  if (SIMULATE) return 'live';
  if (sources.phones === 'live' || sources.ais === 'live') return 'live';
  return [sources.phones !== 'off' && `phones: ${sources.phones}`, sources.ais !== 'off' && `AIS: ${sources.ais}`].filter(Boolean).join(', ');
}

function save() {
  const t = Date.now();
  const recent = {};
  for (const [id, pts] of Object.entries(tracks)) recent[id] = pts.filter((p) => p[0] >= t - RECENT_MS);
  fs.writeFileSync(tracksFile, JSON.stringify({ updated: t, ships: tracks }));
  fs.writeFileSync(liveFile, JSON.stringify({
    updated: t, status: overallStatus(), sources, simulated: SIMULATE, simStartTime,
    aisMessages, feedCheck, phoneUrl, phoneRow, latest, recent,
  }));
  console.log(`${new Date(t).toISOString()} saved: ${Object.keys(latest).length} ships with a position; new positions: ${received.phones} from phones, ${received.ais} from AIS (${aisMessages} AIS messages in the area); sources ${JSON.stringify(sources)}`);
  if (process.env.PUBLISH_CMD) {
    try {
      execSync(process.env.PUBLISH_CMD, { stdio: 'inherit' });
    } catch (err) {
      console.error('Publishing failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------- phones

async function pollPhones() {
  try {
    for (let page = 0; page < 20; page++) {
      const res = await fetch(`${phoneUrl}?fromRow=${phoneRow}`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const [ship, t, lat, lon, sog, cog, batt] of data.rows || []) {
        const before = latest[ship]?.t;
        addPosition({ id: String(ship), t: Number(t), lat: Number(lat), lon: Number(lon), sog: num(sog), cog: num(cog), batt: num(batt), src: 'phone' });
        if (latest[ship]?.t !== before) received.phones++;
      }
      phoneRow = data.nextRow || phoneRow;
      if (!data.more) break;
    }
    sources.phones = 'live';
  } catch (err) {
    sources.phones = 'error: ' + err.message;
    console.error('Could not read phone positions:', err.message);
  }
}

const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

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

const aisSubscription = (box) => JSON.stringify({
  APIKey: aisKey,
  BoundingBoxes: [box],
  FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
});

// Listens to every ship near the course for a short while. The log then shows whether
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
      console.log(`AIS feed check: ${count} position reports from ${seen.size} ships near the course in ${seconds}s${error ? ', error: ' + error : ''}`);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    ws.onopen = () => ws.send(aisSubscription(box));
    ws.onmessage = async (ev) => {
      const msg = await parseMessage(ev);
      if (msg?.error) error = msg.error;
      if (msg?.MetaData) { count++; seen.add(msg.MetaData.MMSI); }
    };
    ws.onerror = (e) => { error = e.message || 'connection error'; };
    ws.onclose = () => { clearTimeout(timer); done(); };
  });
}

function connectAis() {
  if (!idByMmsi.size) {
    sources.ais = 'no ships with a valid MMSI';
    return;
  }
  // We take in every ship in the area and pick out the fleet ourselves.
  const area = listenArea();
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.onopen = () => {
    ws.send(aisSubscription(area));
    sources.ais = 'live';
    console.log(`Connected to aisstream.io, listening in area ${JSON.stringify(area)} for ${idByMmsi.size} ships`);
  };
  ws.onmessage = async (ev) => {
    const msg = await parseMessage(ev);
    if (!msg) return;
    aisMessages++;
    if (msg.error) {
      sources.ais = 'error: ' + msg.error;
      console.error('aisstream error:', msg.error);
      return;
    }
    const body = msg.Message?.[msg.MessageType];
    if (!body || !msg.MetaData) return;
    const id = idByMmsi.get(String(msg.MetaData.MMSI));
    if (!id) return;
    if (!latest[id] || latest[id].src !== 'ais') console.log(`AIS position from ${msg.MetaData.ShipName?.trim() || msg.MetaData.MMSI}`);
    received.ais++;
    addPosition({
      id,
      lat: body.Latitude,
      lon: body.Longitude,
      sog: body.Sog,
      cog: body.Cog,
      hdg: body.TrueHeading === 511 ? null : body.TrueHeading,
      t: Date.now(),
      src: 'ais',
    });
  };
  ws.onerror = (e) => console.error('aisstream connection error', e.message || '');
  ws.onclose = () => {
    if (finished) return;
    sources.ais = 'reconnecting';
    setTimeout(connectAis, 5000);
  };
  socket = ws;
}

// ---------------------------------------------------------------- simulation (testing only)

function startSimulation() {
  const course = config.courses.find((c) => c.id === config.activeCourseId);
  const marks = course?.marks || [];
  if (marks.length < 2) {
    console.error('A simulation needs a course with at least a start and a finish.');
    return;
  }
  const speedup = Number(process.env.SIMULATE_SPEEDUP) || 20;
  const start = marks[0];
  const toFirst = Geo.bearing(Geo.markCenter(start), Geo.markCenter(marks[1]));
  const sims = config.fleet.map((b, i) => {
    const p0 = start.points[0];
    const p1 = start.points[1] || p0;
    const f = (i + 1) / (config.fleet.length + 1);
    const onLine = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
    return { id: b.id, pos: Geo.destination(onLine, toFirst + 180, 0.15), next: 1, speed: 5 + Math.random() * 3, phase: Math.random() * 10, done: false };
  });
  let lastT = Date.now();
  setInterval(() => {
    const t = Date.now();
    const dtH = ((t - lastT) / 3600000) * speedup;
    lastT = t;
    for (const s of sims) {
      let cog = toFirst;
      let sog = 0.5;
      if (t >= simStartTime && !s.done) {
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
      addPosition({ id: s.id, lat: s.pos[0], lon: s.pos[1], sog: +sog.toFixed(1), cog: Math.round(cog), hdg: null, t, src: 'sim' });
    }
  }, 3000);
}

// ---------------------------------------------------------------- keep collecting

// Queue the next run straight away. GitHub runs it as soon as this one ends, so collecting
// doesn't depend on GitHub's timetable (which can be late or skip runs).
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
    console.log(res.ok ? 'Next run queued.' : `Could not queue the next run (HTTP ${res.status}); the 10-minute schedule takes over.`);
  } catch (err) {
    console.error('Could not queue the next run:', err.message);
  }
}

// ---------------------------------------------------------------- run

let socket = null;
let finished = false;
const stopAt = SIMULATE ? now + Math.min(RUN_MS, 15 * 60000) : Math.min(now + RUN_MS, tracking.until);

if (SIMULATE) {
  console.log('SIMULATION mode: made-up ships, not real positions.');
  startSimulation();
} else {
  if (stopAt < tracking.until) queueNextRun();
  if (phoneUrl) {
    pollPhones();
    setInterval(pollPhones, PHONE_POLL_MS);
  }
  if (aisKey) runFeedCheck().then(() => { if (!finished) connectAis(); });
}

const timer = setInterval(save, PUBLISH_MS);
setTimeout(async () => {
  finished = true;
  clearInterval(timer);
  if (socket) socket.close();
  if (phoneUrl) await pollPhones();
  save();
  process.exit(0);
}, Math.max(10000, stopAt - now));
