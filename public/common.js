// Helpers shared by the public page and the admin page.

function createBaseMap(elId) {
  const map = L.map(elId, { zoomControl: true }).setView([52.6, 4.4], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  // Buoys, fairways and other sea marks
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenSeaMap',
  }).addTo(map);
  L.control.scale({ imperial: false, metric: true, nautic: true }).addTo(map);
  return map;
}

function markIcon() {
  return L.divIcon({
    className: '',
    html: '<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="#ffcf33" stroke="#7a5e00" stroke-width="2"/></svg>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function lineEndIcon() {
  return L.divIcon({
    className: '',
    html: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" fill="#ff7a1a" stroke="#6b2d00" stroke-width="2"/></svg>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const ROUNDING_TEXT = { port: 'leave to port', starboard: 'leave to starboard' };

// Labels for each mark. Marks in (almost) the same spot, like a start line
// that is also the finish, share one label: "Start / Finish".
function courseLabels(marks, numbered) {
  const labels = marks.map((m, i) => {
    const side = !numbered && m.rounding ? ` · ${ROUNDING_TEXT[m.rounding]}` : '';
    return (numbered ? `${i + 1}. ` : '') + m.name + side;
  });
  marks.forEach((m, i) => {
    for (let j = 0; j < i; j++) {
      if (labels[j] !== null && m.type === marks[j].type && Geo.distNm(Geo.markCenter(m), Geo.markCenter(marks[j])) < 0.03) {
        labels[j] += ' / ' + labels[i];
        labels[i] = null;
        break;
      }
    }
  });
  return labels;
}

// Draws a course onto a layer group. Returns the group.
function drawCourse(group, course) {
  group.clearLayers();
  if (!course) return group;
  const marks = course.marks;
  if (marks.length > 1) {
    L.polyline(marks.map(Geo.markCenter), { color: '#ff7a1a', weight: 2, dashArray: '6 6', opacity: 0.8 }).addTo(group);
  }
  const labels = courseLabels(marks, false);
  marks.forEach((m, i) => {
    const label = labels[i];
    if (m.type === 'line') {
      const line = L.polyline(m.points, { color: '#ff7a1a', weight: 4 }).addTo(group);
      if (label) line.bindTooltip(label, { permanent: true, direction: 'top', className: 'mark-label' });
      m.points.forEach((p) => L.marker(p, { icon: lineEndIcon(), interactive: false }).addTo(group));
    } else {
      const mk = L.marker(m.points[0], { icon: markIcon() }).addTo(group);
      if (label) mk.bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'mark-label' });
    }
  });
  return group;
}

function boatSvg(color) {
  return `<svg class="boat-arrow" viewBox="0 0 26 26"><path d="M13 2 L20 22 L13 18 L6 22 Z" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDuration(ms) {
  const neg = ms < 0;
  ms = Math.abs(ms);
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const txt = (d ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return neg ? '-' + txt : txt;
}

function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}
