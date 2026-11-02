// Admin page: manage ships, draw courses, set the race start.
const $ = (id) => document.getElementById(id);

let password = sessionStorage.getItem('adminPassword') || '';
let cfg = null;
let selectedId = null;
let dirty = false;
let demo = false;
let pick = null; // what the next map click does: {kind: 'mark'|'line'|'template', points: []}

const map = createBaseMap('map');
const editLayer = L.layerGroup().addTo(map);
const pickLayer = L.layerGroup().addTo(map);

const course = () => cfg.courses.find((c) => c.id === selectedId);

// ---------------------------------------------------------------- login & loading

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(true); throw new Error('Not logged in'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showLogin(wrong) {
  $('login').hidden = false;
  $('loginError').hidden = !wrong;
  $('password').focus();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  password = $('password').value;
  try {
    await api('POST', 'api/admin/login');
    sessionStorage.setItem('adminPassword', password);
    $('login').hidden = true;
    await load();
  } catch { /* showLogin already called */ }
});

async function load() {
  const state = await fetch('api/state').then((r) => r.json());
  cfg = state.config;
  demo = state.demo;
  selectedId = cfg.courses.some((c) => c.id === selectedId) ? selectedId : cfg.activeCourseId || cfg.courses[0]?.id;
  if (!cfg.courses.length) newCourse();
  setDirty(false);
  renderAll();
  fitCourse();
  const pill = $('status');
  pill.className = 'pill ' + (demo ? 'demo' : state.ais === 'live' ? 'live' : 'bad');
  pill.textContent = demo ? 'Demo mode (no AIS key set)' : `AIS: ${state.ais}`;
  $('demoBox').hidden = !demo;
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
  if (badMmsi.length && !confirm(`${badMmsi.map((b) => b.name).join(', ')}: MMSI is not 9 digits, so these ships won't be tracked. Save anyway?`)) return;
  $('saveBtn').disabled = true;
  try {
    const res = await api('PUT', 'api/admin/config', cfg);
    cfg = res.config;
    setDirty(false);
    renderAll();
  } catch (err) {
    alert('Saving failed: ' + err.message);
    $('saveBtn').disabled = false;
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
  return d.toISOString().slice(0, 19);
}

function renderRace() {
  $('raceTitle').value = cfg.title;
  $('raceStart').value = toLocalInput(cfg.race.startTime);
  $('raceRadius').value = cfg.race.roundingRadiusNm;
}

$('raceTitle').addEventListener('input', (e) => { cfg.title = e.target.value; changed(); });
$('raceStart').addEventListener('change', (e) => {
  cfg.race.startTime = e.target.value ? new Date(e.target.value).getTime() : null;
  changed();
});
$('raceRadius').addEventListener('input', (e) => { cfg.race.roundingRadiusNm = Number(e.target.value); changed(); });
$('startNow').addEventListener('click', () => { cfg.race.startTime = Date.now(); renderRace(); changed(); });
$('clearStart').addEventListener('click', () => { cfg.race.startTime = null; renderRace(); changed(); });

$('clearTracks').addEventListener('click', async () => {
  if (!confirm('Delete all saved ship tracks? This cannot be undone.')) return;
  try { await api('POST', 'api/admin/clear-tracks'); alert('Tracks cleared.'); } catch (err) { alert(err.message); }
});
$('restartDemo').addEventListener('click', async () => {
  if (dirty && !confirm('You have unsaved changes. Restart the demo anyway (changes are kept on this page)?')) return;
  try {
    const res = await api('POST', 'api/admin/restart-demo');
    cfg.race.startTime = res.config.race.startTime;
    renderRace();
  } catch (err) { alert(err.message); }
});

// ---------------------------------------------------------------- start

if (password) {
  api('POST', 'api/admin/login').then(() => { $('login').hidden = true; return load(); }).catch(() => {});
} else {
  showLogin(false);
}
