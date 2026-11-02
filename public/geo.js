// Map math shared by the server and the browser.
// Positions are [lat, lon] arrays; distances are in nautical miles (nm).
(function (root) {
  const R_NM = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  function distNm(a, b) {
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x =
      Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
      Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function destination(p, brgDeg, dist) {
    const d = dist / R_NM;
    const brg = toRad(brgDeg);
    const lat1 = toRad(p[0]);
    const lon1 = toRad(p[1]);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [toDeg(lat2), ((toDeg(lon2) + 540) % 360) - 180];
  }

  // Flat x/y (in nm) around a reference point. Accurate enough for a race area.
  function proj(p, ref) {
    return [(p[1] - ref[1]) * 60 * Math.cos(toRad(ref[0])), (p[0] - ref[0]) * 60];
  }

  function distToSegmentNm(p, a, b) {
    const P = proj(p, a);
    const B = proj(b, a);
    const len2 = B[0] * B[0] + B[1] * B[1];
    let t = len2 ? (P[0] * B[0] + P[1] * B[1]) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P[0] - t * B[0], P[1] - t * B[1]);
  }

  function segmentsIntersect(p1, p2, q1, q2) {
    const a = proj(p1, p1), b = proj(p2, p1), c = proj(q1, p1), d = proj(q2, p1);
    const cross = (o, x, y) => (x[0] - o[0]) * (y[1] - o[1]) - (x[1] - o[1]) * (y[0] - o[0]);
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function markCenter(m) {
    if (m.points.length > 1) {
      return [(m.points[0][0] + m.points[1][0]) / 2, (m.points[0][1] + m.points[1][1]) / 2];
    }
    return m.points[0];
  }

  function distToMark(p, m) {
    return m.points.length > 1 ? distToSegmentNm(p, m.points[0], m.points[1]) : distNm(p, m.points[0]);
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  // Ready-made race courses. `start` is the middle of the start line,
  // `windFrom` is the direction the wind blows from (degrees), `leg` is in nm.
  function makeCourse(kind, start, windFrom, leg) {
    const lineHalf = Math.max(0.1, Math.min(0.3, leg * 0.03));
    const line = (center, name) => ({
      id: uid(),
      name,
      type: 'line',
      rounding: '',
      points: [destination(center, windFrom - 90, lineHalf), destination(center, windFrom + 90, lineHalf)],
    });
    const mark = (pos, name, rounding = 'port') => ({ id: uid(), name, type: 'mark', rounding, points: [pos] });

    const windward = destination(start, windFrom, leg);
    if (kind === 'point') {
      return [line(start, 'Start'), line(windward, 'Finish')];
    }
    const leeward = destination(start, windFrom + 180, Math.min(0.3, leg * 0.05));
    if (kind === 'triangle') {
      const mid = destination(start, windFrom, leg / 2);
      const wing = destination(mid, windFrom - 90, leg / 2);
      return [
        line(start, 'Start'),
        mark(windward, 'Mark 1 (windward)'),
        mark(wing, 'Mark 2 (wing)'),
        mark(leeward, 'Mark 3 (leeward)'),
        line(start, 'Finish'),
      ];
    }
    // windward-leeward
    return [
      line(start, 'Start'),
      mark(windward, 'Mark 1 (windward)'),
      mark(leeward, 'Mark 2 (leeward)'),
      line(start, 'Finish'),
    ];
  }

  const Geo = {
    distNm, bearing, destination, distToSegmentNm, segmentsIntersect,
    markCenter, distToMark, makeCourse, uid,
  };
  root.Geo = Geo;
  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
})(typeof window !== 'undefined' ? window : globalThis);
