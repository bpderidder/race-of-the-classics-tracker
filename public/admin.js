// Admin page: manage ships, draw courses, set the race start.
// Settings are saved as config.json in the GitHub repository, using a GitHub access key.
const $ = (id) => document.getElementById(id);
const S = window.TRACKER_SETTINGS;
const TOKEN_KEY = 'trackerGithubKey';

let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage blocked */ }
let cfg = null;
let cfgSha = null; // version of config.json on GitHub, needed to save
let selectedId = null;
let dirty = false;
let pick = null; // what the next map click does: {kind: 'mark'|'line'|'template', points: []}

const map = createBaseMap('map');
const editLayer = L.layerGroup().addTo(map);
const pickLayer = L.layerGroup().addTo(map);

const course = () => cfg.courses.find((c) => c.id === selectedId);

// ---------------------------------------------------------------- GitHub

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${S.repo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub said ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function showLogin(message) {
  $('login').hidden = false;
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
  $('password').focus();
}

async function login() {
  const repo = await github('GET', '');
  if (!repo.permissions?.push) throw new Error('This key can read the repository but not change it. Give it "Contents: Read and write" access.');
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked */ }
  $('login').hidden = true;
  await load();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('password').value.trim();
  try {
    await login();
  } catch (err) {
    showLogin(err.status === 401 ? 'GitHub did not accept this key.' : err.message);
  }
});

async function load() {
  try {
    const file = await github('GET', `/contents/config.json?ref=${S.configBranch}`);
    cfg = JSON.parse(fromBase64(file.content));
    cfgSha = file.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    cfg = { title: 'Race of the Classics – Live', fleet: [], courses: [], activeCourseId: null, race: {}, tracking: {} };
    cfgSha = null;
  }
  cfg.race ||= {};
  cfg.race.roundingRadiusNm ||= 0.15;
  cfg.tracking ||= {};
  selectedId = cfg.courses.some((c) => c.id === selectedId) ? selectedId : cfg.activeCourseId || cfg.courses[0]?.id;
  if (!cfg.courses.length) newCourse();
  setDirty(!cfgSha);
  renderAll();
  fitCourse();
  $('status').className = 'pill';
  $('status').textContent = `Saving to github.com/${S.repo}`;
}

function setDirty(v) {
  dirty = v;
  $('dirty').hidden = !v;
  $('saveBtn').disabled = !v;
}
const changed = () => setDirty(true);
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

$('saveBtn').addEventListener('click', async () => {
  const badMmsi = cfg.fleet.filter((b) => !/^\d{9}$/.test(b.mmsi));
  if (badMmsi.length && !confirm(`${badMmsi.map((b) => b.name || 'Unnamed ship').join(', ')}: MMSI is not 9 digits, so these ships won't be tracked. Save anyway?`)) return;
  if (cfg.tracking.from && cfg.tracking.until && cfg.tracking.until <= cfg.tracking.from) return alert('The tracking period ends before it starts.');
  $('saveBtn').disabled = true;
  try {
    const res = await github('PUT', '/contents/config.json', {
      message: 'Update race settings from the admin page',
      content: toBase64(JSON.stringify(cfg, null, 2) + '\n'),
      branch: S.configBranch,
      ...(cfgSha ? { sha: cfgSha } : {}),
    });
    cfgSha = res.content.sha;
    setDirty(false);
    renderAll();
    $('status').textContent = 'Saved. The public page shows it within a few minutes.';
  } catch (err) {
    $('saveBtn').disabled = false;
    if (err.status === 409 || err.status === 422) {
      alert('The settings were changed somewhere else in the meantime. Reload the page and make your change again.');
    } else if (err.status === 401) {
      showLogin('Your GitHub key no longer works. Log in with a new one.');
    } else {
      alert('Saving failed: ' + err.message);
    }
  }
});

function renderAll() {
  renderCourseControls();
  renderMarks();
  renderCourseMap();
  renderFleet();
  renderRace();
}

// ---------------------------------------------------------------- tabs

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + btn.dataset.tab; });
  });
});

// ---------------------------------------------------------------- courses

function newCourse() {
  const c = { id: Geo.uid(), name: `Course ${cfg.courses.length + 1}`, marks: [] };
  cfg.courses.push(c);
  if (!cfg.activeCourseId) cfg.activeCourseId = c.id;
  selectedId = c.id;
  changed();
}

function renderCourseControls() {
  const sel = $('courseSelect');
  sel.innerHTML = cfg.courses.map((c) =>
    `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}${c.id === cfg.activeCourseId ? '  ★ in use' : ''}</option>`
  ).join('');
  const c = course();
  $('courseName').value = c?.name || '';
  const active = c && c.id === cfg.activeCourseId;
  $('activateCourse').textContent = active ? '★ This course is used for the race' : 'Use this course for the race';
  $('activateCourse').classList.toggle('active', !!active);
  $('activateCourse').disabled = !!active;
}

$('courseSelect').addEventListener('change', (e) => {
  selectedId = e.target.value;
  cancelPick();
  renderAll();
  fitCourse();
});
$('newCourse').addEventListener('click', () => { newCourse(); renderAll(); $('templateBox').open = true; });
$('courseName').addEventListener('input', (e) => { course().name = e.target.value; changed(); renderCourseControls(); });
$('deleteCourse').addEventListener('click', () => {
  if (cfg.courses.length <= 1) return alert('You need at least one course.');
  if (!confirm(`Delete course "${course().name}"?`)) return;
  cfg.courses = cfg.courses.filter((c) => c.id !== selectedId);
  if (cfg.activeCourseId === selectedId) cfg.activeCourseId = cfg.courses[0].id;
  selectedId = cfg.courses[0].id;
  changed();
  renderAll();
  fitCourse();
});
$('activateCourse').addEventListener('click', () => { cfg.activeCourseId = selectedId; changed(); renderCourseControls(); });

function markDescription(m, i, total) {
  if (i === 0) return 'Start';
  if (i === total - 1) return 'Finish';
  return m.type === 'line' ? 'Gate / line' : `Mark ${i}`;
}

function renderMarks() {
  const c = course();
  const list = $('markList');
  if (!c || !c.marks.length) {
    list.innerHTML = '<li class="empty">No marks yet. Use the quick start above, or add marks below.</li>';
    return;
  }
  list.innerHTML = c.marks.map((m, i) => `
    <li data-i="${i}">
      <div class="top">
        <span class="meta">${i + 1}. ${markDescription(m, i, c.marks.length)} · ${m.type === 'line' ? 'line' : 'single mark'}</span>
        <span class="ctrls">
          <button class="btn small" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small" data-act="down" title="Move down" ${i === c.marks.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn small" data-act="zoom" title="Show on map">⌖</button>
          <button class="btn small danger-outline" data-act="del" title="Delete">✕</button>
        </span>
      </div>
      <div class="fields">
        <input type="text" data-field="name" value="${escapeHtml(m.name)}" aria-label="Name">
        <select data-field="rounding" aria-label="Rounding side">
          <option value="" ${!m.rounding ? 'selected' : ''}>—</option>
          <option value="port" ${m.rounding === 'port' ? 'selected' : ''}>to port</option>
          <option value="starboard" ${m.rounding === 'starboard' ? 'selected' : ''}>to starboard</option>
        </select>
      </div>
    </li>`).join('');
}

$('markList').addEventListener('input', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const m = course().marks[+li.dataset.i];
  m[e.target.dataset.field] = e.target.value;
  changed();
  renderCourseMap();
});
$('markList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  const li = e.target.closest('li[data-i]');
  if (!btn || !li) return;
  const marks = course().marks;
  const i = +li.dataset.i;
  const act = btn.dataset.act;
  if (act === 'zoom') return map.flyTo(Geo.markCenter(marks[i]), Math.max(map.getZoom(), 13));
  if (act === 'del') marks.splice(i, 1);
  if (act === 'up') [marks[i - 1], marks[i]] = [marks[i], marks[i - 1]];
  if (act === 'down') [marks[i + 1], marks[i]] = [marks[i], marks[i + 1]];
  changed();
  renderMarks();
  renderCourseMap();
});

function renderCourseMap() {
  editLayer.clearLayers();
  const c = course();
  if (!c) return;
  if (c.marks.length > 1) {
    L.polyline(c.marks.map(Geo.markCenter), { color: '#ff7a1a', weight: 2, dashArray: '6 6' }).addTo(editLayer);
  }
  const labels = courseLabels(c.marks, true);
  c.marks.forEach((m, i) => {
    const label = labels[i];
    if (m.type === 'line') {
      const line = L.polyline(m.points, { color: '#ff7a1a', weight: 4 }).addTo(editLayer);
      if (label) line.bindTooltip(label, { permanent: true, direction: 'top', className: 'mark-label' });
      m.points.forEach((p, j) => {
        const mk = L.marker(p, { icon: lineEndIcon(), draggable: true }).addTo(editLayer);
        mk.on('drag', (e) => { m.points[j] = [e.latlng.lat, e.latlng.lng]; line.setLatLngs(m.points); });
        mk.on('dragend', () => { changed(); renderCourseMap(); });
      });
    } else {
      const mk = L.marker(m.points[0], { icon: markIcon(), draggable: true }).addTo(editLayer);
      if (label) mk.bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'mark-label' });
      mk.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        m.points[0] = [ll.lat, ll.lng];
        changed();
        renderCourseMap();
      });
    }
  });
}

function fitCourse() {
  const pts = (course()?.marks || []).flatMap((m) => m.points);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 14 });
}

// Picking points on the map
function startPick(kind, hint) {
  cancelPick();
  pick = { kind, points: [] };
  $('map').classList.add('picking');
  $('mapHint').innerHTML = `${hint} <button class="btn small" id="cancelPick">Cancel</button>`;
  $('mapHint').hidden = false;
  $('cancelPick').addEventListener('click', cancelPick);
  if (window.innerWidth <= 760) $('map').scrollIntoView({ behavior: 'smooth' });
}
function cancelPick() {
  pick = null;
  pickLayer.clearLayers();
  $('map').classList.remove('picking');
  $('mapHint').hidden = true;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPick(); });

map.on('click', (e) => {
  if (!pick) return;
  const p = [e.latlng.lat, e.latlng.lng];
  const c = course();
  if (pick.kind === 'mark') {
    c.marks.splice(Math.max(c.marks.length - 1, c.marks.length === 1 ? 1 : 0), 0, {
      id: Geo.uid(), name: `Mark ${c.marks.length}`, type: 'mark', rounding: 'port', points: [p],
    });
    insertedAt(c);
  } else if (pick.kind === 'line') {
    pick.points.push(p);
    if (pick.points.length === 1) {
      L.marker(p, { icon: lineEndIcon() }).addTo(pickLayer);
      $('mapHint').firstChild.textContent = 'Now click the other end of the line. ';
      return;
    }
    const name = c.marks.length === 0 ? 'Start' : c.marks.length === 1 ? 'Finish' : `Gate ${c.marks.length}`;
    const line = { id: Geo.uid(), name, type: 'line', rounding: '', points: pick.points };
    // A new line goes at the end when the course has 0-1 items, otherwise just before the finish.
    if (c.marks.length < 2) c.marks.push(line);
    else c.marks.splice(c.marks.length - 1, 0, line);
    insertedAt(c);
  } else if (pick.kind === 'template') {
    if (c.marks.length && !confirm('Replace the marks of this course with the standard course?')) return cancelPick();
    c.marks = Geo.makeCourse($('tplKind').value, p, Number($('tplWind').value) || 0, Math.max(0.2, Number($('tplLeg').value) || 1));
    insertedAt(c);
    fitCourse();
  }
});

function insertedAt() {
  cancelPick();
  changed();
  renderMarks();
  renderCourseMap();
}

$('addMark').addEventListener('click', () => startPick('mark', 'Click on the map where the mark is.'));
$('addLine').addEventListener('click', () => startPick('line', 'Click one end of the line. '));
$('tplPlace').addEventListener('click', () => startPick('template', 'Click on the map where the start line should be.'));

// ---------------------------------------------------------------- fleet

function renderFleet() {
  $('fleetList').innerHTML = cfg.fleet.map((b, i) => `
    <div class="boat-card" data-i="${i}">
      <div class="head">
        <input type="color" data-field="color" value="${b.color}" aria-label="Color">
        <input type="text" data-field="name" value="${escapeHtml(b.name)}" placeholder="Ship name" aria-label="Ship name">
        <button class="btn small danger-outline" data-act="del" title="Remove ship">✕</button>
      </div>
      <div class="grid">
        <label>MMSI<input type="text" inputmode="numeric" data-field="mmsi" value="${escapeHtml(b.mmsi)}" class="${/^\d{9}$/.test(b.mmsi) ? '' : 'bad-input'}"></label>
        <label>Team / association<input type="text" data-field="team" value="${escapeHtml(b.team)}"></label>
      </div>
    </div>`).join('') || '<p class="help">No ships yet.</p>';
}

$('fleetList').addEventListener('input', (e) => {
  const card = e.target.closest('.boat-card');
  if (!card) return;
  const b = cfg.fleet[+card.dataset.i];
  b[e.target.dataset.field] = e.target.value;
  if (e.target.dataset.field === 'mmsi') {
    b.mmsi = e.target.value.replace(/\D/g, '');
    e.target.classList.toggle('bad-input', !/^\d{9}$/.test(b.mmsi));
  }
  changed();
});
$('fleetList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  const i = +btn.closest('.boat-card').dataset.i;
  if (!confirm(`Remove ${cfg.fleet[i].name}?`)) return;
  cfg.fleet.splice(i, 1);
  changed();
  renderFleet();
});

const PALETTE = ['#e6194b', '#3c78d8', '#2e9e44', '#f58231', '#911eb4', '#0aa5a5', '#c2185b', '#6d4c41', '#7cb342', '#283593'];
$('addBoat').addEventListener('click', () => {
  cfg.fleet.push({ id: Geo.uid(), name: '', team: '', mmsi: '', color: PALETTE[cfg.fleet.length % PALETTE.length] });
  changed();
  renderFleet();
  $('fleetList').lastElementChild.querySelector('input[data-field="name"]').focus();
});

// ---------------------------------------------------------------- race settings

function toLocalInput(t) {
  if (!t) return '';
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

function renderRace() {
  $('raceTitle').value = cfg.title;
  $('raceStart').value = toLocalInput(cfg.race.startTime);
  $('raceRadius').value = cfg.race.roundingRadiusNm;
  $('trackFrom').value = toLocalInput(cfg.tracking.from);
  $('trackUntil').value = toLocalInput(cfg.tracking.until);
  const now = Date.now();
  const { from, until } = cfg.tracking;
  $('trackingNote').textContent = !from || !until
    ? 'No tracking period set, so no positions are being collected.'
    : now < from ? 'Tracking has not started yet.'
    : now > until ? 'The tracking period is over.'
    : 'Positions are being collected right now.';
  $('actionsLink').href = `https://github.com/${S.repo}/actions/workflows/collect.yml`;
}

$('raceTitle').addEventListener('input', (e) => { cfg.title = e.target.value; changed(); });
$('raceStart').addEventListener('change', (e) => { cfg.race.startTime = fromLocalInput(e.target.value); changed(); });
$('trackFrom').addEventListener('change', (e) => { cfg.tracking.from = fromLocalInput(e.target.value); changed(); renderRace(); });
$('trackUntil').addEventListener('change', (e) => { cfg.tracking.until = fromLocalInput(e.target.value); changed(); renderRace(); });
$('raceRadius').addEventListener('input', (e) => { cfg.race.roundingRadiusNm = Number(e.target.value); changed(); });
$('startNow').addEventListener('click', () => { cfg.race.startTime = Date.now(); renderRace(); changed(); });
$('clearStart').addEventListener('click', () => { cfg.race.startTime = null; renderRace(); changed(); });

// ---------------------------------------------------------------- start

if (token) {
  login().catch((err) => showLogin(err.status === 401 ? 'Your saved GitHub key no longer works. Log in again.' : err.message));
} else {
  showLogin();
}
