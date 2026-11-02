// Public live tracker page. Reads everything from the GitHub repository (see data.js).
// New positions are published every 30 seconds. Each visitor may ask GitHub about 60 times
// an hour, so the page checks just over once a minute.
const LIVE_EVERY_MS = 65000;
const CONFIG_EVERY_MS = 10 * 60000;
const TRACKS_EVERY_MS = 10 * 60000;
const STALE_MS = 15 * 60000; // a position older than this is shown as faded

const map = createBaseMap('map');
const courseLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const boatLayer = L.layerGroup().addTo(map);

let config = null;
let live = null; // latest live.json
let history = {}; // mmsi -> [[t, lat, lon]] from tracks.json
let board = [];
const markers = new Map();
const trackLines = new Map();
let fitted = false;

const boatByMmsi = (mmsi) => config?.fleet.find((b) => b.mmsi === mmsi);
const activeCourse = () => config?.courses.find((c) => c.id === config.activeCourseId);
const latest = () => live?.latest || {};
const startTime = () => (live?.simulated ? live.simStartTime : config?.race.startTime) || null;

// Full track per ship: the saved history plus the most recent points from live.json.
function mergedTracks() {
  const out = {};
  for (const boat of config?.fleet || []) {
    const old = history[boat.mmsi] || [];
    const lastT = old.length ? old[old.length - 1][0] : 0;
    const recent = (live?.recent?.[boat.mmsi] || []).filter((p) => p[0] > lastT);
    const pts = old.concat(recent);
    const l = latest()[boat.mmsi];
    if (l && (!pts.length || l.t > pts[pts.length - 1][0])) pts.push([l.t, l.lat, l.lon]);
    out[boat.mmsi] = pts;
  }
  return out;
}

function render() {
  if (!config) return;
  const tracks = mergedTracks();
  // Ships removed from the fleet
  for (const [mmsi, m] of markers) if (!boatByMmsi(mmsi)) { boatLayer.removeLayer(m); markers.delete(mmsi); }
  for (const [mmsi, l] of trackLines) if (!boatByMmsi(mmsi)) { trackLayer.removeLayer(l); trackLines.delete(mmsi); }

  for (const boat of config.fleet) {
    const pts = tracks[boat.mmsi];
    let line = trackLines.get(boat.mmsi);
    if (!line) {
      line = L.polyline([], { weight: 2.5, opacity: 0.75 }).addTo(trackLayer);
      trackLines.set(boat.mmsi, line);
    }
    line.setStyle({ color: boat.color });
    line.setLatLngs(pts.map((p) => [p[1], p[2]]));
    const pos = latest()[boat.mmsi];
    if (pos) updateBoat(boat, pos);
  }

  const course = activeCourse();
  board = Race.standings({
    fleet: config.fleet,
    marks: course?.marks || [],
    startTime: startTime(),
    radiusNm: config.race.roundingRadiusNm || 0.15,
    tracks,
    latest: latest(),
    now: Date.now(),
  });
  renderBoard();
  renderStatus();
  if (!fitted) fitView();
}

function applyConfig(c) {
  config = c;
  document.getElementById('title').textContent = c.title;
  document.title = c.title;
  drawCourse(courseLayer, activeCourse());
}

function fitView() {
  const pts = [];
  activeCourse()?.marks.forEach((m) => pts.push(...m.points));
  Object.values(latest()).forEach((p) => pts.push([p.lat, p.lon]));
  if (pts.length) {
    map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 13 });
    fitted = true;
  }
}

function boatIcon(boat, stale) {
  return L.divIcon({
    className: '',
    html: `<div class="boat-icon${stale ? ' is-stale' : ''}">${boatSvg(boat.color)}<span class="boat-label">${escapeHtml(boat.name)}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function popupHtml(boat, p) {
  return `<strong>${escapeHtml(boat.name)}</strong>${boat.team ? `<br>${escapeHtml(boat.team)}` : ''}
    <br>Speed: ${p.sog ?? '–'} kn · Course: ${p.cog ?? '–'}°
    <br>Last update: ${formatAgo(Date.now() - p.t)}`;
}

function updateBoat(boat, p) {
  const stale = Date.now() - p.t > STALE_MS;
  const key = `${boat.color}|${boat.name}|${stale}`;
  let m = markers.get(boat.mmsi);
  if (!m) {
    m = L.marker([p.lat, p.lon], { icon: boatIcon(boat, stale), zIndexOffset: 1000 }).addTo(boatLayer);
    m.bindPopup('');
    m.on('popupopen', () => {
      const b = boatByMmsi(boat.mmsi);
      const pos = latest()[boat.mmsi];
      if (b && pos) m.setPopupContent(popupHtml(b, pos));
    });
    markers.set(boat.mmsi, m);
  } else {
    m.setLatLng([p.lat, p.lon]);
    if (m._key !== key) m.setIcon(boatIcon(boat, stale));
  }
  m._key = key;
  const heading = p.hdg ?? p.cog;
  const arrow = m.getElement()?.querySelector('.boat-arrow');
  if (arrow && heading != null) arrow.style.transform = `rotate(${heading}deg)`;
  if (m.isPopupOpen()) m.setPopupContent(popupHtml(boat, p));
}

function renderBoard() {
  const el = document.getElementById('board');
  const start = startTime();
  el.innerHTML = board.map((r) => {
    const boat = boatByMmsi(r.mmsi);
    if (!boat) return '';
    const p = latest()[r.mmsi];
    let status;
    if (r.finishedAt) status = `<span class="finished">Finished · ${formatDuration(r.finishedAt - start)}</span>`;
    else if (r.remainingNm != null) status = `Next: ${escapeHtml(r.nextMark)} · ${r.remainingNm.toFixed(1)} nm to go`;
    else if (!p) status = 'No position received yet';
    else status = boat.team ? escapeHtml(boat.team) : '';
    const age = p ? Date.now() - p.t : null;
    const right = p ? `${p.sog ?? '–'} kn<br><span class="${age > STALE_MS ? 'stale' : ''}">${formatAgo(age)}</span>` : '';
    return `<li data-mmsi="${r.mmsi}">
      <span class="rank">${r.rank ?? '–'}</span>
      <span class="boat-name"><span class="dot" style="background:${boat.color}"></span>${escapeHtml(boat.name)}</span>
      <span class="right">${right}</span>
      <span class="sub">${status}</span>
    </li>`;
  }).join('');
}

function renderStatus() {
  const el = document.getElementById('status');
  el.className = 'pill';
  const age = live ? Date.now() - live.updated : Infinity;
  if (live?.simulated && age < 30 * 60000) {
    el.textContent = 'Test – simulated ships';
    el.classList.add('demo');
  } else if (age < 10 * 60000 && live.status === 'live') {
    el.textContent = '● Live · updates every minute';
    el.classList.add('live');
  } else if (age < 10 * 60000) {
    el.textContent = `AIS: ${live.status}`;
    el.classList.add('bad');
  } else {
    el.textContent = live ? `Not tracking · last update ${formatAgo(age)}` : 'Not tracking yet';
  }
}

document.getElementById('board').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-mmsi]');
  const m = li && markers.get(li.dataset.mmsi);
  if (m) {
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.8 });
    m.openPopup();
    if (window.innerWidth <= 760) setPanel(false);
  }
});

function setPanel(open) {
  const panel = document.getElementById('panel');
  panel.classList.toggle('collapsed', !open);
  document.getElementById('panelToggle').setAttribute('aria-expanded', open);
  document.getElementById('panelToggle').textContent = open ? 'Standings ▾' : 'Standings ▴';
  setTimeout(() => map.invalidateSize(), 50);
}
document.getElementById('panelToggle').addEventListener('click', () => {
  setPanel(document.getElementById('panel').classList.contains('collapsed'));
});
if (window.innerWidth <= 760) setPanel(true);

function tickClock() {
  const el = document.getElementById('clock');
  const start = startTime();
  if (!start) el.textContent = 'Start time not set';
  else if (Date.now() < start) el.textContent = `Start in ${formatDuration(start - Date.now())}`;
  else el.textContent = `Race time ${formatDuration(Date.now() - start)}`;
}

// ---------------------------------------------------------------- loading

async function loadConfig() {
  const c = await RepoData.config();
  if (c) applyConfig(c);
}
async function loadLive() {
  live = await RepoData.live();
}
async function loadTracks() {
  const t = await RepoData.tracks();
  history = t?.ships || {};
}
const safely = (fn) => () => fn().then(render).catch((err) => console.error(err));

(async () => {
  try {
    await Promise.all([loadConfig(), loadLive(), loadTracks()]);
    render();
  } catch (err) {
    document.getElementById('status').textContent = 'Could not load data';
    console.error(err);
  }
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(safely(loadLive), LIVE_EVERY_MS);
  setInterval(safely(loadConfig), CONFIG_EVERY_MS);
  setInterval(safely(loadTracks), TRACKS_EVERY_MS);
  setInterval(render, 30000); // keep "x min ago" texts current
})();
