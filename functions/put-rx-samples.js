import {
  assertValidGeohash,
  isValidRssi
} from '../content/shared.js'

export async function onRequest(context) {
  const request = context.request;
  const data = await request.json();

  assertValidGeohash(data.hash);
  const hash = data.hash;
  const time = Date.now();
  const info = data.info;

  if (!isValidRssi(info.rssi))
    throw new Error("RSSI too high, likely from mobile repeater.");

  if (info == null || info.time == null || info.rssi == null
    || info.snr == null || info.repeater == null || info.time === 0)
    return;

  const sample = {
    time: info.time,
    rssi: info.rssi,
    snr: info.snr,
    repeater: info.repeater
  };

  await context.env.DB
    .prepare(`
      INSERT INTO rx_samples (hash, time, samples)
      VALUES (?, ?, json_array(json(?)))
      ON CONFLICT(hash) DO UPDATE SET
        time = excluded.time,
        samples = (
          SELECT json_group_array(json(value)) FROM (
            SELECT
              v AS value,
              CAST(json_extract(v, '$.time') AS INTEGER) AS t
            FROM (
              SELECT json(e.value) AS v
              FROM json_each(rx_samples.samples) AS e
              UNION
              SELECT json(n.value) AS v
              FROM json_each(excluded.samples) AS n
            )
            ORDER BY t DESC
            LIMIT 25
          )
        )
    `)
    .bind(hash, time, JSON.stringify(sample))
    .run();

  return new Response('OK');
}
