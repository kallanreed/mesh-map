import * as util from '../content/shared.js';

// Pull live data into the local emulator.
// NB: This is for the old KV style, use SQL export for new builds.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const result = {
    imported_samples: 0,
    imported_repeaters: 0
  };

  if (url.hostname !== "localhost")
    return new Response("Only works in Wrangler.");

  const resp = await fetch("https://mesh-map-89j.pages.dev/get-nodes");
  const data = await resp.json();

  const sampleInsertStmts = data.samples.map(s => {
    return context.env.DB
      .prepare(`
        INSERT OR IGNORE INTO samples
          (hash, time, rssi, snr, observed, repeaters)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        s.id,
        util.fromTruncatedTime(s.time),
        s.rssi ?? null,
        s.snr ?? null,
        s.obs ? 1 : 0,
        JSON.stringify(s.path ?? [])
      );
  });
  await context.env.DB.batch(sampleInsertStmts);
  result.imported_samples = sampleInsertStmts.length;

  const repeaterInsertStmts = data.repeaters.map(r => {
    return context.env.DB
    .prepare(`
      INSERT OR REPLACE INTO repeaters
        (id, hash, time, name, elevation)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      r.id,
      r.hash,
      util.fromTruncatedTime(r.time),
      r.name,
      r.elev ?? null
    );
  });
  await context.env.DB.batch(repeaterInsertStmts);
  result.imported_repeaters = repeaterInsertStmts.length;

  return Response.json(result);
}
