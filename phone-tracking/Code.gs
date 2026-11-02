/**
 * Race tracker – receives phone positions (Google Apps Script).
 *
 * Setup (see README.md, "Phone tracking"):
 *  1. Make a new Google Sheet, then Extensions -> Apps Script, and paste this whole file.
 *  2. Choose the function "setup" at the top and click Run. Allow access when asked.
 *     The execution log then shows your phone key.
 *  3. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone.
 *     Copy the web app URL (ends in /exec).
 *
 * Phones (the OwnTracks app) send their position to:  <web app URL>?ship=<ship code>&key=<phone key>
 * The tracker website reads recent positions from:   <web app URL>
 * The GitHub collector reads the full history from:  <web app URL>?fromRow=2
 */

var SHEET_NAME = 'positions';
var RECENT_MS = 60 * 60 * 1000; // the live feed holds the last hour of each ship's track
var RECENT_MAX = 150; // ...and at most this many points per ship
var HISTORY_MAX_ROWS = 5000; // rows per history request

function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('WRITE_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('WRITE_KEY', key);
  }
  sheet_();
  Logger.log('Your phone key is: ' + key);
  Logger.log('Paste it on the tracker admin page, Phones tab. Keep it private.');
}

// ---------------------------------------------------------------- receiving positions

function doPost(e) {
  var params = (e && e.parameter) || {};
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_([]);
  }
  // OwnTracks also sends other kinds of messages (status, waypoints...). Only locations matter.
  if (body._type !== 'location') return json_([]);

  var key = PropertiesService.getScriptProperties().getProperty('WRITE_KEY');
  if (!key || params.key !== key) return json_([]);
  var ship = String(params.ship || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(ship)) return json_([]);

  var pos = {
    t: Number(body.tst) * 1000 || Date.now(),
    lat: Number(body.lat),
    lon: Number(body.lon),
    sog: isNum_(body.vel) ? round_(body.vel / 1.852, 1) : null, // OwnTracks speed is km/h
    cog: isNum_(body.cog) ? Number(body.cog) : null,
    batt: isNum_(body.batt) ? Number(body.batt) : null,
  };
  if (!isNum_(pos.lat) || !isNum_(pos.lon) || Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) return json_([]);
  if (pos.lat === 0 && pos.lon === 0) return json_([]);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet_().appendRow([new Date(), ship, pos.t, pos.lat, pos.lon, pos.sog, pos.cog, pos.batt]);
    var recent = recent_();
    addRecent_(recent, ship, pos);
    CacheService.getScriptCache().put('recent', JSON.stringify(recent), 21600);
  } finally {
    lock.releaseLock();
  }
  // OwnTracks expects a JSON list back
  return json_([]);
}

// ---------------------------------------------------------------- reading positions

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.fromRow) return json_(history_(Number(params.fromRow)));
  return json_(recent_());
}

function history_(fromRow) {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  fromRow = Math.max(2, Math.floor(fromRow) || 2);
  if (fromRow > last) return { nextRow: fromRow, rows: [] };
  var count = Math.min(HISTORY_MAX_ROWS, last - fromRow + 1);
  var values = sheet.getRange(fromRow, 2, count, 7).getValues();
  return { nextRow: fromRow + count, more: fromRow + count <= last, rows: values };
}

// The last hour of positions per ship, kept in a cache so reading it is fast.
function recent_() {
  var cached = CacheService.getScriptCache().get('recent');
  if (cached) return JSON.parse(cached);
  var recent = { ships: {} };
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var first = Math.max(2, last - 3000);
    var rows = sheet.getRange(first, 2, last - first + 1, 7).getValues();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      addRecent_(recent, String(r[0]), { t: Number(r[1]), lat: Number(r[2]), lon: Number(r[3]), sog: num_(r[4]), cog: num_(r[5]), batt: num_(r[6]) });
    }
  }
  return recent;
}

function addRecent_(recent, ship, pos) {
  var s = recent.ships[ship] || (recent.ships[ship] = { latest: null, points: [] });
  if (!s.latest || pos.t >= s.latest.t) s.latest = pos;
  var pts = s.points;
  var point = [pos.t, round_(pos.lat, 5), round_(pos.lon, 5)];
  // Positions sent late (after being out of signal) go in the right place in time
  var i = pts.length;
  while (i > 0 && pts[i - 1][0] > pos.t) i--;
  if (!(i > 0 && pts[i - 1][0] === pos.t)) pts.splice(i, 0, point);
  var cutoff = s.latest.t - RECENT_MS;
  while (pts.length && (pts[0][0] < cutoff || pts.length > RECENT_MAX)) pts.shift();
  recent.updated = Date.now();
}

// ---------------------------------------------------------------- helpers

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['received', 'ship', 'time (ms)', 'lat', 'lon', 'speed (kn)', 'course', 'battery %']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isNum_(v) {
  return v !== null && v !== undefined && v !== '' && isFinite(Number(v));
}

function num_(v) {
  return isNum_(v) ? Number(v) : null;
}

function round_(v, digits) {
  var f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}
