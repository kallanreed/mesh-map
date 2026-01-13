// Gets all samples, coverage, and repeaters for the map.
// Lots of data to send back, so fields are minimized.
import * as util from '../content/shared.js';

export async function onRequest(context) {
  const responseData = {
    coverage: [],
    samples: [],
    repeaters: []
  };

  // TODO: Merge RxLog data here too?
  // Coverage
  const { results: coverage } = await context.env.DB
    .prepare(`
      SELECT hash, time, lastObserved, lastHeard, observed,
        heard, lost, rssi, snr, repeaters FROM coverage`).all();
  coverage.forEach(c => {
    const meshIds = JSON.parse(c.mesh_ids || '[]');
    const rptr = JSON.parse(c.repeaters || '[]');
    const item = {
      id: c.hash,
      obs: c.observed,
      hrd: c.heard,
      lost: c.lost,
      ut: util.truncateTime(c.time),
      lot: util.truncateTime(c.lastObserved),
      lht: util.truncateTime(c.lastHeard),
    };

    // Don't send empty values.
    if (meshIds.length > 0)
      item.msh == meshIds;
    if (rptr.length > 0)
      item.rptr = rptr;
    if (c.snr != null) item.snr = c.snr;
    if (c.rssi != null) item.rssi = c.rssi;

    responseData.coverage.push(item);
  });

  // Samples
  // TODO: merge samples into coverage server-side?
  const { results: samples } = await context.env.DB
    .prepare("SELECT * FROM samples").all();
  samples.forEach(s => {
    const meshIds = JSON.parse(s.mesh_ids || '[]');
    const path = JSON.parse(s.repeaters || '[]');
    const item = {
      id: s.hash,
      time: util.truncateTime(s.time ?? 0),
      obs: s.observed
    };

    // Don't send empty values.
    if (meshIds.length > 0)
      item.msh = meshIds;
    if (path.length > 0)
      item.path = path;
    if (s.snr != null) item.snr = s.snr;
    if (s.rssi != null) item.rssi = s.rssi;

    responseData.samples.push(item);
  });

  // Repeaters
  const { results: repeaters } = await context.env.DB
    .prepare("SELECT * FROM repeaters").all();
  repeaters.forEach(r => {
    const item = {
      id: r.id,
      hash: r.hash,
      name: r.name,
      time: util.truncateTime(r.time ?? 0),
      elev: Math.round(r.elevation ?? 0)
    };

    responseData.repeaters.push(item);
  });

  return Response.json(responseData);
}
