// Where settings and ship tracks are saved.
// - If DATABASE_URL is set (e.g. a free Neon Postgres database), everything goes there.
//   Use this on hosts that don't keep files between restarts, like Hugging Face Spaces.
// - Otherwise everything is saved as files in DATA_DIR.
const fs = require('fs');
const path = require('path');

function fileStorage(dataDir, demo) {
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  const trackFile = path.join(dataDir, demo ? 'positions-demo.jsonl' : 'positions.jsonl');
  let stream = null;
  const openStream = () => (stream = fs.createWriteStream(trackFile, { flags: 'a' }));

  return {
    name: `files in ${dataDir}`,
    async load() {
      let config = null;
      try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* first run */ }
      const positions = [];
      if (fs.existsSync(trackFile)) {
        for (const line of fs.readFileSync(trackFile, 'utf8').split('\n')) {
          if (!line) continue;
          try { positions.push(JSON.parse(line)); } catch { /* skip damaged line */ }
        }
      }
      openStream();
      return { config, positions };
    },
    async saveConfig(c) {
      const tmp = configFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
      fs.renameSync(tmp, configFile);
    },
    addPosition(p) {
      stream.write(JSON.stringify(p) + '\n');
    },
    async clearPositions() {
      stream.end();
      fs.writeFileSync(trackFile, '');
      openStream();
    },
  };
}

function postgresStorage(url, demo) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true } });
  pool.on('error', (err) => console.error('Database connection error:', err.message));
  const table = demo ? 'positions_demo' : 'positions';
  let queue = [];

  // Positions are written in small batches every few seconds.
  async function flush() {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const values = [];
    const rows = batch.map((p, i) => {
      values.push(p.mmsi, p.t, p.lat, p.lon, p.sog ?? null, p.cog ?? null, p.hdg ?? null);
      const o = i * 7;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
    });
    try {
      await pool.query(`INSERT INTO ${table} (mmsi, t, lat, lon, sog, cog, hdg) VALUES ${rows.join(',')}`, values);
    } catch (err) {
      console.error('Could not save positions, will retry:', err.message);
      queue = batch.concat(queue).slice(-5000);
    }
  }
  setInterval(flush, 5000);

  return {
    name: 'Postgres database',
    async load() {
      await pool.query('CREATE TABLE IF NOT EXISTS settings (id INT PRIMARY KEY, data JSONB NOT NULL)');
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
        mmsi TEXT NOT NULL, t BIGINT NOT NULL, lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL,
        sog REAL, cog REAL, hdg REAL)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_mmsi_t ON ${table} (mmsi, t)`);
      const cfg = await pool.query('SELECT data FROM settings WHERE id = 1');
      const pos = await pool.query(`SELECT mmsi, t, lat, lon, sog, cog, hdg FROM ${table} ORDER BY t`);
      return {
        config: cfg.rows[0]?.data || null,
        positions: pos.rows.map((r) => ({ ...r, t: Number(r.t) })),
      };
    },
    async saveConfig(c) {
      await pool.query(
        'INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
        [JSON.stringify(c)]
      );
    },
    addPosition(p) {
      queue.push(p);
    },
    async clearPositions() {
      queue = [];
      await pool.query(`DELETE FROM ${table}`);
    },
  };
}

module.exports = function createStorage({ databaseUrl, dataDir, demo }) {
  return databaseUrl ? postgresStorage(databaseUrl, demo) : fileStorage(dataDir, demo);
};
