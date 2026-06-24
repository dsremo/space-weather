CREATE TABLE IF NOT EXISTS kp_index (
  ts TEXT PRIMARY KEY,
  kp REAL,
  a_running REAL
);
CREATE TABLE IF NOT EXISTS solar_wind (
  ts TEXT PRIMARY KEY,
  speed REAL,
  density REAL
);
CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  kp_rows INTEGER,
  wind_rows INTEGER
);
