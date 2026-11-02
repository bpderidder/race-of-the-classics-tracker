// Race of the Classics - live AIS regatta tracker.
// Settings come from environment variables (see README.md):
//   AISSTREAM_API_KEY  key from aisstream.io. Leave empty to run in demo mode.
//   ADMIN_PASSWORD     password for the /admin page.
//   DATABASE_URL       Postgres database (e.g. free Neon) to save settings and tracks in.
//   DATA_DIR           folder where settings and tracks are saved when there's no DATABASE_URL.
//   PORT               web server port (hosting platforms set this for you).

const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const Geo = require('./public/geo.js');
const createStorage = require('./storage.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AIS_KEY = (process.env.AISSTREAM_API_KEY || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const DEMO = !AIS_KEY || process.env.DEMO === '1';

// How often a position is saved to a boat's track (positions still update live in between).
const TRACK_INTERVAL_MS = DEMO ? 4000 : 20000;

const storage = createStorage({ databaseUrl: (process.env.DATABASE_URL || '').trim(), dataDir: DATA_DIR, demo: DEMO });

// ---------------------------------------------------------------- settings

function defaultConfig() {
  const course = {
    id: Geo.uid(),
    name: 'Demo course (off IJmuiden)',
    marks: Geo.makeCourse('triangle', [52.5, 4.38], 225, 6),
  };
  const colors = ['#e6194b', '#3c78d8', '#2e9e44', '#f58231', '#911eb4', '#0aa5a5'];
  return {
    title: 'Race of the Classics – Live',
    fleet: colors.map((color, i) => ({
      id: Geo.uid(),
      name: `Demo ship ${i + 1}`,
      team: `Team ${String.fromCharCode(65 + i)}`,
      mmsi: String(999000001 + i),
      color,
    })),
    courses: [course],
    activeCourseId: course.id,
    race: { startTime: null, roundingRadiusNm: 0.15 },
  };
}

function saveConfig(c) {
  return storage.saveConfig(c).catch((err) => {
    console.error('Could not save settings:', err.message);
    throw err;
  });
}

function cleanConfig(input) {
  const str = (v, max = 80) => String(v ?? '').slice(0, max);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const point = (p) => [num(p[0]), num(p[1])];
  const validPoint = (p) => p[0] !== null && p[1] !== null && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  const courses = (input.courses || []).map((c) => ({
    id: str(c.id, 20) || Geo.uid(),
    name: str(c.name) || 'Course',
    marks: (c.marks || [])
      .map((m) => ({
        id: str(m.id, 20) || Geo.uid(),
        name: str(m.name) || 'Mark',
        type: m.type === 'line' ? 'line' : 'mark',
        rounding: ['port', 'starboard'].includes(m.rounding) ? m.rounding : '',
        points: (m.points || []).slice(0, m.type === 'line' ? 2 : 1).map(point),
      }))
      .filter((m) => m.points.length === (m.type === 'line' ? 2 : 1) && m.points.every(validPoint)),
  }));
  return {
    title: str(input.title, 120) || 'Race tracker',
    fleet: (input.fleet || []).map((b) => ({
      id: str(b.id, 20) || Geo.uid(),
      name: str(b.name) || 'Unnamed ship',
      team: str(b.team),
      mmsi: str(b.mmsi, 20).replace(/\D/g, ''),
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#3c78d8',
    })),
    courses,
    activeCourseId: courses.some((c) => c.id === input.activeCourseId) ? input.activeCourseId : courses[0]?.id || null,
    race: {
      startTime: num(input.race?.startTime),
      roundingRadiusNm: Math.min(2, Math.max(0.02, num(input.race?.roundingRadiusNm) || 0.15)),
    },
  };
}

let config = null; // loaded at startup
const activeCourse = () => config.courses.find((c) => c.id === config.activeCourseId) || null;
const inFleet = (mmsi) => config.fleet.some((b) => b.mmsi === mmsi);

// ---------------------------------------------------------------- positions & race progress

const latest = new Map(); // mmsi -> {mmsi, lat, lon, sog, cog, hdg, t}
const tracks = new Map(); // mmsi -> [[t, lat, lon], ...]
const progress = new Map(); // mmsi -> {next, finishedAt}

function loadTracks(positions) {
  for (const p of positions) {
    if (!tracks.has(p.mmsi)) tracks.set(p.mmsi, []);
    tracks.get(p.mmsi).push([p.t, p.lat, p.lon]);
    const prev = latest.get(p.mmsi);
    if (!prev || p.t >= prev.t) latest.set(p.mmsi, p);
  }
}

function stepProgress(st, a, b, t) {
  const course = activeCourse();
  const start = config.race.startTime;
  if (!course || course.marks.length < 2 || !start || t < start || st.finishedAt) return;
  if (st.next < 1) st.next = 1;
  const mark = course.marks[st.next];
  if (!mark) return;
  let reached = Geo.distToMark(b, mark) <= config.race.roundingRadiusNm;
  if (!reached && a && mark.type === 'line') {
    reached = Geo.segmentsIntersect(a, b, mark.points[0], mark.points[1]);
  }
  if (reached) {
    if (st.next === course.marks.length - 1) st.finishedAt = t;
    else st.next++;
  }
}

function recomputeProgress() {
  progress.clear();
  for (const boat of config.fleet) {
    const st = { next: 0, finishedAt: null };
    let prev = null;
    for (const [t, lat, lon] of tracks.get(boat.mmsi) || []) {
      stepProgress(st, prev, [lat, lon], t);
      prev = [lat, lon];
    }
    const last = latest.get(boat.mmsi);
    if (last) stepProgress(st, prev, [last.lat, last.lon], last.t);
    progress.set(boat.mmsi, st);
  }
}

const lastStored = new Map();

function addPosition(pos) {
  if (!inFleet(pos.mmsi)) return;
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return;
  if (Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) return; // 91/181 means "no position"
  const prev = latest.get(pos.mmsi);
  if (prev && pos.t < prev.t) return;

  if (!progress.has(pos.mmsi)) progress.set(pos.mmsi, { next: 0, finishedAt: null });
  stepProgress(progress.get(pos.mmsi), prev ? [prev.lat, prev.lon] : null, [pos.lat, pos.lon], pos.t);
  latest.set(pos.mmsi, pos);

  if (pos.t - (lastStored.get(pos.mmsi) || 0) >= TRACK_INTERVAL_MS) {
    lastStored.set(pos.mmsi, pos.t);
    if (!tracks.has(pos.mmsi)) tracks.set(pos.mmsi, []);
    tracks.get(pos.mmsi).push([pos.t, pos.lat, pos.lon]);
    storage.addPosition(pos);
  }
  broadcast('pos', pos);
  boardDirty = true;
}

function clearTracks() {
  tracks.clear();
  latest.clear();
  lastStored.clear();
  storage.clearPositions().catch((err) => console.error('Could not clear saved tracks:', err.message));
  recomputeProgress();
}

function leaderboard() {
  const course = activeCourse();
  const marks = course?.marks || [];
  const started = config.race.startTime && Date.now() >= config.race.startTime;
  const rows = config.fleet.map((boat) => {
    const pos = latest.get(boat.mmsi);
    const st = progress.get(boat.mmsi) || { next: 0, finishedAt: null };
    let remainingNm = null;
    if (started && pos && marks.length >= 2 && !st.finishedAt) {
      const next = Math.max(1, st.next);
      remainingNm = Geo.distNm([pos.lat, pos.lon], Geo.markCenter(marks[next]));
      for (let i = next; i < marks.length - 1; i++) {
        remainingNm += Geo.distNm(Geo.markCenter(marks[i]), Geo.markCenter(marks[i + 1]));
      }
    }
    return {
      mmsi: boat.mmsi,
      nextMark: started && !st.finishedAt && marks.length >= 2 ? marks[Math.max(1, st.next)]?.name : null,
      remainingNm,
      finishedAt: st.finishedAt,
    };
  });
  rows.sort((a, b) => {
    if (a.finishedAt || b.finishedAt) return (a.finishedAt || Infinity) - (b.finishedAt || Infinity);
    return (a.remainingNm ?? Infinity) - (b.remainingNm ?? Infinity);
  });
  let rank = 0;
  for (const r of rows) r.rank = started && (r.finishedAt || r.remainingNm !== null) ? ++rank : null;
  return rows;
}

// ---------------------------------------------------------------- live updates to browsers

const clients = new Set();
let boardDirty = false;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => {
  if (boardDirty) {
    boardDirty = false;
    broadcast('board', leaderboard());
  }
}, 2000);
setInterval(() => {
  for (const res of clients) res.write(': keep-alive\n\n');
}, 25000);

// ---------------------------------------------------------------- AIS feed (aisstream.io)

let aisStatus = DEMO ? 'demo' : 'starting';
let aisSocket = null;
let aisRetry = 2000;

function setStatus(s) {
  if (s === aisStatus) return;
  aisStatus = s;
  broadcast('status', { ais: aisStatus });
}

function connectAis() {
  if (aisSocket) {
    aisSocket.removeAllListeners();
    aisSocket.on('error', () => {});
    aisSocket.terminate();
    aisSocket = null;
  }
  const mmsis = config.fleet.map((b) => b.mmsi).filter((m) => /^\d{9}$/.test(m));
  if (!mmsis.length) return setStatus('no ships with a valid MMSI');

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  aisSocket = ws;
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        APIKey: AIS_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: mmsis.slice(0, 50),
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
      })
    );
    setStatus('live');
    aisRetry = 2000;
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.error) {
      console.error('aisstream error:', msg.error);
      return setStatus('error: ' + msg.error);
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
  });
  ws.on('error', (err) => console.error('aisstream connection error:', err.message));
  ws.on('close', () => {
    if (aisSocket !== ws) return;
    setStatus('reconnecting');
    setTimeout(connectAis, aisRetry);
    aisRetry = Math.min(aisRetry * 2, 60000);
  });
}

// ---------------------------------------------------------------- demo mode (simulated ships)

const SIM_SPEEDUP = Number(process.env.DEMO_SPEEDUP) || 20; // demo ships sail 20x faster than real life
const sim = new Map();
let demoFinishedAt = null;

function resetDemo(startInMs = 30000) {
  sim.clear();
  demoFinishedAt = null;
  config.race.startTime = Date.now() + startInMs;
  saveConfig(config).catch(() => {});
  clearTracks();
  broadcast('config', config);
}

function tickDemo() {
  const course = activeCourse();
  const marks = course?.marks || [];
  if (marks.length < 2) return;
  const now = Date.now();
  const start = marks[0];
  const first = Geo.markCenter(marks[1]);
  const toFirst = Geo.bearing(Geo.markCenter(start), first);

  config.fleet.forEach((boat, i) => {
    if (!sim.has(boat.mmsi)) {
      const p0 = start.points[0];
      const p1 = start.points[1] || start.points[0];
      const f = (i + 1) / (config.fleet.length + 1);
      const onLine = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
      sim.set(boat.mmsi, {
        pos: Geo.destination(onLine, toFirst + 180, 0.15),
        next: 1,
        speed: 5 + Math.random() * 3,
        phase: Math.random() * 10,
        lastT: now,
        done: false,
      });
    }
    const s = sim.get(boat.mmsi);
    const dtH = ((now - s.lastT) / 3600000) * SIM_SPEEDUP;
    s.lastT = now;
    let cog = toFirst;
    let sog = 0.5;
    if (now >= config.race.startTime && !s.done) {
      const target = Geo.markCenter(marks[s.next]);
      cog = (Geo.bearing(s.pos, target) + 12 * Math.sin(now / 9000 + s.phase) + 360) % 360;
      sog = s.speed * (0.85 + 0.15 * Math.sin(now / 13000 + s.phase));
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
    addPosition({ mmsi: boat.mmsi, lat: s.pos[0], lon: s.pos[1], sog: +sog.toFixed(1), cog: Math.round(cog), hdg: null, t: now });
  });

  const all = [...sim.values()];
  if (all.length && all.every((s) => s.done)) {
    if (!demoFinishedAt) demoFinishedAt = now;
    if (now - demoFinishedAt > 120000) resetDemo();
  }
}

// ---------------------------------------------------------------- web server

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/state', (req, res) => {
  res.json({ config, latest: [...latest.values()], board: leaderboard(), ais: aisStatus, demo: DEMO, serverTime: Date.now() });
});

app.get('/api/tracks', (req, res) => {
  const from = config.race.startTime ? config.race.startTime - 3600000 : Date.now() - 12 * 3600000;
  const step = DEMO ? 0 : 60000; // send at most one point per minute per ship
  const out = {};
  for (const boat of config.fleet) {
    const pts = [];
    let lastT = 0;
    for (const [t, lat, lon] of tracks.get(boat.mmsi) || []) {
      if (t < from || t - lastT < step) continue;
      lastT = t;
      pts.push([t, +lat.toFixed(5), +lon.toFixed(5)]);
    }
    out[boat.mmsi] = pts;
  }
  res.json(out);
});

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function requireAdmin(req, res, next) {
  if (req.get('x-admin-password') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
}

app.post('/api/admin/login', requireAdmin, (req, res) => res.json({ ok: true }));

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const before = config.fleet.map((b) => b.mmsi).sort().join(',');
  const next = cleanConfig(req.body || {});
  try {
    await saveConfig(next);
  } catch (err) {
    return res.status(500).json({ error: 'Could not save to storage: ' + err.message });
  }
  config = next;
  recomputeProgress();
  broadcast('config', config);
  broadcast('board', leaderboard());
  if (DEMO) resetDemo(15000); // restart the simulated race with the new fleet/course
  else if (config.fleet.map((b) => b.mmsi).sort().join(',') !== before) connectAis();
  res.json({ ok: true, config });
});

app.post('/api/admin/clear-tracks', requireAdmin, (req, res) => {
  clearTracks();
  if (DEMO) resetDemo(15000);
  broadcast('config', config);
  broadcast('board', leaderboard());
  res.json({ ok: true });
});

app.post('/api/admin/restart-demo', requireAdmin, (req, res) => {
  if (!DEMO) return res.status(400).json({ error: 'Not in demo mode' });
  resetDemo();
  res.json({ ok: true, config });
});

// ---------------------------------------------------------------- start

async function main() {
  console.log(`Saving data in: ${storage.name}`);
  const saved = await storage.load();
  config = saved.config ? cleanConfig(saved.config) : defaultConfig();
  if (!saved.config) await saveConfig(config);
  loadTracks(saved.positions);
  recomputeProgress();
  if (DEMO) {
    console.log('No AISSTREAM_API_KEY set: running in DEMO mode with simulated ships.');
    resetDemo();
    setInterval(tickDemo, 2000);
  } else {
    connectAis();
  }
  if (ADMIN_PASSWORD === 'changeme') console.warn('WARNING: ADMIN_PASSWORD is not set. The admin password is "changeme".');
  app.listen(PORT, () => console.log(`Race tracker running on http://localhost:${PORT}  (admin: /admin)`));
}

main().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
