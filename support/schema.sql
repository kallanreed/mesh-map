-- Uncomment if necessary, but this will destroy existing data.
--DROP TABLE IF EXISTS samples;
--DROP TABLE IF EXISTS sample_archive;
--DROP TABLE IF EXISTS repeaters;
--DROP TABLE IF EXISTS coverage;
--DROP TABLE IF EXISTS senders;
--DROP TABLE IF EXISTS rx_samples;

CREATE TABLE IF NOT EXISTS samples (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  rssi REAL CHECK (rssi IS NULL OR typeof(rssi) = 'real'),
  snr  REAL CHECK (snr  IS NULL OR typeof(snr)  = 'real'),
  observed  INTEGER NOT NULL DEFAULT 0 CHECK (observed IN (0, 1)),
  repeaters TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_samples_time ON samples(time);

CREATE TABLE IF NOT EXISTS sample_archive (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repeaters (
  id TEXT NOT NULL,
  hash TEXT NOT NULL,
  time INTEGER NOT NULL,
  name TEXT NOT NULL,
  elevation REAL CHECK (elevation IS NULL OR typeof(elevation) = 'real'),
  PRIMARY KEY (id, hash)
);
CREATE INDEX IF NOT EXISTS idx_repeaters_time ON repeaters(time);

CREATE TABLE IF NOT EXISTS coverage (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  lastObserved INTEGER NOT NULL DEFAULT 0,
  lastHeard INTEGER NOT NULL DEFAULT 0,
  observed INTEGER NOT NULL DEFAULT 0,
  heard INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  rssi REAL CHECK (rssi IS NULL OR typeof(rssi) = 'real'),
  snr  REAL CHECK (snr  IS NULL OR typeof(snr)  = 'real'),
  repeaters TEXT NOT NULL DEFAULT '[]',
  entries TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_coverage_time ON coverage(time);

CREATE TABLE IF NOT EXISTS senders (
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  time INTEGER NOT NULL,
  PRIMARY KEY (hash, name, time)
);
CREATE INDEX IF NOT EXISTS idx_senders_hash ON senders(hash);
CREATE INDEX IF NOT EXISTS idx_senders_name ON senders(name);
CREATE INDEX IF NOT EXISTS idx_senders_time ON senders(time);

CREATE TABLE IF NOT EXISTS rx_samples (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  samples TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(samples) AND json_type(samples)='array')
);
CREATE INDEX IF NOT EXISTS idx_rx_samples_time ON rx_samples(time);

-- VIEWS ---
--DROP VIEW IF EXISTS v_rx_expanded;
--DROP VIEW IF EXISTS v_rx_ui;

CREATE VIEW IF NOT EXISTS v_rx_expanded AS
SELECT
  rs.hash,
  rs.time,
  json_extract(e.value, '$.repeater') AS repeater,
  CAST(json_extract(e.value, '$.rssi') AS REAL) AS rssi,
  CAST(json_extract(e.value, '$.snr') AS REAL) AS snr
FROM rx_samples rs
JOIN json_each(rs.samples) e;

CREATE VIEW IF NOT EXISTS v_rx_ui AS
WITH
  by_hash_repeater AS (
    SELECT
      hash,
      repeater as id,
      time,
      SUM(rssi) as rssi_sum,
      SUM(snr) as snr_sum,
      COUNT(*) as n,
      MAX(rssi) as rssi_max,
      MAX(snr) as snr_max
    FROM v_rx_expanded
    GROUP BY hash, repeater
  )

SELECT
  hash,
  MAX(time) as time,
  SUM(n) as count,
  SUM(rssi_sum) * 1.0 / SUM(n) as rssi,
  SUM(snr_sum) * 1.0 / SUM(n) as snr,
  json_group_array(
    json_object(
      'id', id,
      'count', n,
      'rssi_max', rssi_max,
      'rssi_avg', (rssi_sum * 1.0 / n),
      'snr_max', snr_max,
      'snr_avg', (snr_sum * 1.0 / n)
    )
    ORDER BY (rssi_sum * 1.0 / n) DESC, id
  ) as repeaters
FROM by_hash_repeater
GROUP BY hash