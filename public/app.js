// Public live tracker page.
const STALE_MS = 15 * 60 * 1000; // a position older than this is shown as "stale"

const map = createBaseMap('map');
const courseLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const boatLayer = L.layerGroup().addTo(map);

let config = null;
let board = [];
let clockOffset = 0; // server time minus browser time
const latest = new Map();
const markers = new Map();
const trackLines = new Map();
let fitted = false;
let demo = false;

const now = () => Date.now() + clockOffset;
const boatByMmsi = (mmsi) => config?.fleet.find((b) => b.mmsi === mmsi);
const activeCourse = () => config?.courses.find((c) => c.id === config.activeCourseId);

async function loadAll() {
  const [state, tracks] = await Promise.all([
    fetch('api/state').then((r) => r.json()),
    fetch('api/tracks').then((r) => r.json()),
  ]);
  clockOffset = state.serverTime - Date.now();
  applyConfig(state.config);
  demo = state.demo;
  setStatus(state.ais, state.demo);
  latest.clear();
  state.latest.forEach((p) => latest.set(p.mmsi, p));
  trackLayer.clearLayers();
  trackLines.clear();
  for (const [mmsi, pts] of Object.entries(tracks)) {
    const boat = boatByMmsi(mmsi);
    if (!boat) continue;
    trackLines.set(mmsi, L.polyline(pts.map((p) => [p[1], p[2]]), { color: boat.color, weight: 2.5, opacity: 0.75 }).addTo(trackLayer));
  }
  latest.forEach(updateBoat);
  board = state.board;
  renderBoard();
  if (!fitted) fitView();
}

function applyConfig(c) {
  config = c;
  document.getElementById('title').textContent = c.title;
  document.title = c.title;
  drawCourse(courseLayer, activeCourse());
  // Remove ships that are no longer in the fleet
  for (const [mmsi, m] of markers) {
    if (!boatByMmsi(mmsi)) { boatLayer.removeLayer(m); markers.delete(mmsi); }
  }
}

function fitView() {
  const pts = [];
  activeCourse()?.marks.forEach((m) => pts.push(...m.points));
  latest.forEach((p) => pts.push([p.lat, p.lon]));
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
    <br>Last update: ${formatAgo(now() - p.t)}`;
}

function updateBoat(p) {
  const boat = boatByMmsi(p.mmsi);
  if (!boat) return;
  const stale = now() - p.t > STALE_MS;
  let m = markers.get(p.mmsi);
  if (!m) {
    m = L.marker([p.lat, p.lon], { icon: boatIcon(boat, stale), zIndexOffset: 1000 }).addTo(boatLayer);
    m.bindPopup('');
    m.on('popupopen', () => m.setPopupContent(popupHtml(boat, latest.get(p.mmsi))));
    markers.set(p.mmsi, m);
    m._stale = stale;
    m._color = boat.color;
    m._name = boat.name;
  } else {
    m.setLatLng([p.lat, p.lon]);
    if (m._stale !== stale || m._color !== boat.color || m._name !== boat.name) {
      m.setIcon(boatIcon(boat, stale));
      m._stale = stale; m._color = boat.color; m._name = boat.name;
    }
  }
  const heading = p.hdg ?? p.cog;
  const arrow = m.getElement()?.querySelector('.boat-arrow');
  if (arrow && heading != null) arrow.style.transform = `rotate(${heading}deg)`;
  if (m.isPopupOpen()) m.setPopupContent(popupHtml(boat, p));
}

function addTrackPoint(p) {
  const boat = boatByMmsi(p.mmsi);
  if (!boat) return;
  let line = trackLines.get(p.mmsi);
  if (!line) {
    line = L.polyline([], { color: boat.color, weight: 2.5, opacity: 0.75 }).addTo(trackLayer);
    trackLines.set(p.mmsi, line);
  }
  line.addLatLng([p.lat, p.lon]);
}

function renderBoard() {
  const el = document.getElementById('board');
  if (!config) return;
  const start = config.race.startTime;
  el.innerHTML = board.map((r) => {
    const boat = boatByMmsi(r.mmsi);
    if (!boat) return '';
    const p = latest.get(r.mmsi);
    let status;
    if (r.finishedAt) status = `<span class="finished">Finished · ${formatDuration(r.finishedAt - start)}</span>`;
    else if (r.remainingNm != null) status = `Next: ${escapeHtml(r.nextMark)} · ${r.remainingNm.toFixed(1)} nm to go`;
    else if (!p) status = 'No position received yet';
    else status = boat.team ? escapeHtml(boat.team) : '';
    const age = p ? now() - p.t : null;
    const right = p
      ? `${p.sog ?? '–'} kn<br><span class="${age > STALE_MS ? 'stale' : ''}">${formatAgo(age)}</span>`
      : '';
    return `<li data-mmsi="${r.mmsi}">
      <span class="rank">${r.rank ?? '–'}</span>
      <span class="boat-name"><span class="dot" style="background:${boat.color}"></span>${escapeHtml(boat.name)}</span>
      <span class="right">${right}</span>
      <span class="sub">${status}</span>
    </li>`;
  }).join('');
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

function setStatus(ais, demo) {
  const el = document.getElementById('status');
  el.className = 'pill';
  if (demo) { el.textContent = 'Demo – simulated ships'; el.classList.add('demo'); }
  else if (ais === 'live') { el.textContent = '● Live AIS'; el.classList.add('live'); }
  else { el.textContent = `AIS: ${ais}`; el.classList.add('bad'); }
}

function tickClock() {
  const el = document.getElementById('clock');
  const start = config?.race.startTime;
  if (!start) el.textContent = 'Start time not set';
  else if (now() < start) el.textContent = `Start in ${formatDuration(start - now())}`;
  else el.textContent = `Race time ${formatDuration(now() - start)}`;
}
setInterval(tickClock, 1000);
setInterval(() => { latest.forEach(updateBoat); renderBoard(); }, 15000);

// Live updates from the server
let lastStored = new Map();
function connectStream() {
  const es = new EventSource('api/stream');
  es.addEventListener('pos', (e) => {
    const p = JSON.parse(e.data);
    latest.set(p.mmsi, p);
    updateBoat(p);
    // Extend the track line, but not more often than the server saves track points
    if (p.t - (lastStored.get(p.mmsi) || 0) >= (demo ? 2000 : 20000)) { addTrackPoint(p); lastStored.set(p.mmsi, p.t); }
  });
  es.addEventListener('board', (e) => { board = JSON.parse(e.data); renderBoard(); });
  es.addEventListener('status', (e) => setStatus(JSON.parse(e.data).ais, demo));
  es.addEventListener('config', () => loadAll());
  es.addEventListener('open', () => loadAll()); // also re-sync after a dropped connection
}

loadAll().then(connectStream).catch((err) => {
  document.getElementById('status').textContent = 'Could not reach server';
  console.error(err);
});
tickClock();
