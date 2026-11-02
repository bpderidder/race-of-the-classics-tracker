// Works out which mark each ship is heading for, and the standings.
// A ship has reached a mark when its track passes within the rounding distance of it,
// or crosses a line (start, finish, gate).
(function (root) {
  const Geo = root.Geo || require('./geo.js');

  function reachedMark(mark, a, b, radiusNm) {
    if (mark.type === 'line') {
      if (Geo.distToSegmentNm(b, mark.points[0], mark.points[1]) <= radiusNm) return true;
      return !!a && Geo.segmentsIntersect(a, b, mark.points[0], mark.points[1]);
    }
    // Distance from the mark to the stretch sailed between two position reports
    return a ? Geo.distToSegmentNm(mark.points[0], a, b) <= radiusNm : Geo.distNm(b, mark.points[0]) <= radiusNm;
  }

  function closestApproach(mark, a, b) {
    const c = Geo.markCenter(mark);
    return a ? Geo.distToSegmentNm(c, a, b) : Geo.distNm(b, c);
  }

  // track: [[t, lat, lon], ...] sorted by time
  // Safety net: positions arrive about once a minute, so a track can cut a corner and
  // just miss a mark. If a ship came near the mark it was heading for (within 3x the
  // rounding distance) and then reaches the mark after it, the first one counts too.
  function progressFor(track, marks, startTime, radiusNm) {
    const st = { next: 1, finishedAt: null };
    let prev = null;
    let nearest = Infinity; // closest the ship came to the mark it is heading for
    for (const [t, lat, lon] of track) {
      const p = [lat, lon];
      if (t >= startTime && !st.finishedAt && marks[st.next]) {
        const mark = marks[st.next];
        const after = marks[st.next + 1];
        let advance = 0;
        if (reachedMark(mark, prev, p, radiusNm)) advance = 1;
        else {
          nearest = Math.min(nearest, closestApproach(mark, prev, p));
          if (after && nearest <= 3 * radiusNm && reachedMark(after, prev, p, radiusNm)) advance = 2;
        }
        if (advance) {
          nearest = Infinity;
          if (st.next + advance > marks.length - 1) st.finishedAt = t;
          else st.next += advance;
        }
      }
      prev = p;
    }
    return st;
  }

  // Returns rows sorted by position: {mmsi, rank, nextMark, remainingNm, finishedAt}
  function standings({ fleet, marks, startTime, radiusNm, tracks, latest, now }) {
    const started = startTime && now >= startTime && marks.length >= 2;
    const rows = fleet.map((boat) => {
      const pos = latest[boat.mmsi];
      const row = { mmsi: boat.mmsi, nextMark: null, remainingNm: null, finishedAt: null };
      if (!started || !pos) return row;
      const st = progressFor(tracks[boat.mmsi] || [], marks, startTime, radiusNm);
      if (st.finishedAt) {
        row.finishedAt = st.finishedAt;
        return row;
      }
      row.nextMark = marks[st.next].name;
      let d = Geo.distNm([pos.lat, pos.lon], Geo.markCenter(marks[st.next]));
      for (let i = st.next; i < marks.length - 1; i++) d += Geo.distNm(Geo.markCenter(marks[i]), Geo.markCenter(marks[i + 1]));
      row.remainingNm = d;
      return row;
    });
    rows.sort((a, b) => {
      if (a.finishedAt || b.finishedAt) return (a.finishedAt || Infinity) - (b.finishedAt || Infinity);
      return (a.remainingNm ?? Infinity) - (b.remainingNm ?? Infinity);
    });
    let rank = 0;
    for (const r of rows) r.rank = r.finishedAt || r.remainingNm !== null ? ++rank : null;
    return rows;
  }

  const Race = { standings, progressFor, reachedMark };
  root.Race = Race;
  if (typeof module !== 'undefined' && module.exports) module.exports = Race;
})(typeof window !== 'undefined' ? window : globalThis);
