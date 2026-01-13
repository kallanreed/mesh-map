import {
  geohash6,
  geohash8,
  isValidRssi,
  parseLocation
} from '../content/shared.js'

export async function onRequest(context) {
  const request = context.request;
  const data = await request.json();

  // If the RSSI it really high, it's probably from a mobile repeater.
  // Ignore the radio stats and path in that case.
  if (!isValidRssi(data.rssi)) {
    data.rssi = null;
    data.snr = null;
    data.path = [];
  }

  // TODO: Pass in geohash directly.
  const [lat, lon] = parseLocation(data.lat, data.lon);
  const hash = geohash8(lat, lon);
  const time = Date.now();
  const rssi = data.rssi ?? null;
  const snr = data.snr ?? null;
  const mesh = data.mesh?.toUpperCase() ?? null;
  const mesh_ids = mesh ? [mesh] : [];
  const path = (data.path ?? []).map(p => p.toLowerCase());
  const observed = data.observed ?? false;
  const sender = data.sender ?? null


  await context.env.DB
    .prepare(`
      INSERT INTO samples (hash, time, rssi, snr, observed, mesh_ids, repeaters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        time = excluded.time,
        rssi = CASE
          WHEN samples.rssi IS NULL THEN excluded.rssi
          WHEN excluded.rssi IS NULL THEN samples.rssi
          ELSE MAX(samples.rssi, excluded.rssi)
        END,
        snr = CASE
          WHEN samples.snr IS NULL THEN excluded.snr
          WHEN excluded.snr IS NULL THEN samples.snr
          ELSE MAX(samples.snr, excluded.snr)
        END,
        observed = MAX(samples.observed, excluded.observed),
        mesh_ids = (
          SELECT json_group_array(value) FROM (
            SELECT value
            FROM json_each(COALESCE(samples.mesh_ids, '[]'))
            UNION
            SELECT value
            FROM json_each(COALESCE(excluded.mesh_ids, '[]'))
            ORDER BY value
          )
        ),
        repeaters = (
          SELECT json_group_array(value) FROM (
            SELECT value FROM json_each(samples.repeaters)
            UNION
            SELECT value FROM json_each(excluded.repeaters)
          )
        )
    `)
    .bind(hash, time, rssi, snr, observed ? 1 : 0, JSON.stringify(mesh_ids), JSON.stringify(path))
    .run();

  if (sender) {
    const todayStart = (new Date()).setHours(0, 0, 0, 0);
    await context.env.DB
      .prepare("INSERT OR IGNORE INTO senders (hash, name, time) VALUES (?, ?, ?)")
      .bind(geohash6(lat, lon), sender.substring(0, 32), todayStart)
      .run();
  }

  return new Response('OK');
}
