// Consolidates old samples into coverage elements and archives them.
import * as util from '../content/shared.js';

// TODO: App-token for 'auth'?
// TODO: More of this could be handled in SQL.

// Samples are consolidated after they are this age in days.
const DEF_CONSOLIDATE_AGE = 1;

// Only the N-newest samples are kept so that
// recent samples can eventually flip a coverage tile.
const MAX_SAMPLES_PER_COVERAGE = 15;

function consolidateSamples(samples, cutoffTime) {
  // To avoid people spamming the coverage data and blowing
  // up the history, merge the batch of new samples into
  // one uber-entry per-consolidation. That way spamming
  // has to happen over N consolidations.
  const uberSample = {
    time: 0,
    observed: 0,
    heard: 0,
    lost: 0,
    snr: null,
    rssi: null,
    lastObserved: 0,
    lastHeard: 0,
    mesh_ids: [],
    repeaters: [],
  };

  // Build the uber sample.
  samples.forEach(s => {
    // Was this sample handled in a previous batch?
    if (s.time <= cutoffTime)
      return;

    uberSample.time = Math.max(s.time, uberSample.time);
    uberSample.snr = util.definedOr(Math.max, s.snr, uberSample.snr);
    uberSample.rssi = util.definedOr(Math.max, s.rssi, uberSample.rssi);

    if (s.observed) {
      uberSample.observed++;
      uberSample.lastObserved = Math.max(s.time, uberSample.lastObserved);
    }

    const mesh_ids = JSON.parse(s.mesh_ids || '[]');
    mesh_ids.forEach(id => {
      id = id.toUpperCase();
      if (!uberSample.mesh_ids.includes(id))
        uberSample.mesh_ids.push(id);
    });

    const repeaters = JSON.parse(s.repeaters || '[]');
    if (s.observed || repeaters.length > 0) {
      uberSample.heard++;
      uberSample.lastHeard = Math.max(s.time, uberSample.lastHeard);
    } else {
      uberSample.lost++;
    }

    repeaters.forEach(p => {
      p = p.toLowerCase();
      if (!uberSample.repeaters.includes(p))
        uberSample.repeaters.push(p);
    });
  });

  // If uberSample has invalid time, all samples must have
  // been handled previously, nothing left to do.
  if (uberSample.time === 0)
    return null;
  else
    return uberSample;
}

// Merge the new coverage data with the previous (if any).
async function mergeCoverage(key, samples, DB) {
  // Get existing coverage entry (or defaults).

  const row = await DB
    .prepare("SELECT * FROM coverage WHERE hash = ?")
    .bind(key).first();

  const prevRepeaters = JSON.parse(row?.repeaters || '[]');
  const prevUpdated = row?.time ?? 0;
  let entries = JSON.parse(row?.entries || '[]');

  const uberSample = consolidateSamples(samples, prevUpdated);
  if (uberSample === null)
    return;

  entries.push(uberSample);

  // Are there too many entries?
  if (entries.length > MAX_SAMPLES_PER_COVERAGE) {
    // Sort and keep the N-newest entries.
    entries = entries.toSorted((a, b) => a.time - b.time).slice(-MAX_SAMPLES_PER_COVERAGE);
  }

  // Compute new stats, but keep the existing repeater list (for now).
  const updatedRow = {
    hash: key,
    time: uberSample.time,
    lastObserved: 0,
    lastHeard: 0,
    observed: 0,
    heard: 0,
    lost: 0,
    rssi: null,
    snr: null,
    mesh_ids: [],
    repeaters: [],
    entries: entries,
  };
  const meshIdSet = new Set();
  const repeaterSet = new Set(prevRepeaters);
  entries.forEach(e => {
    updatedRow.lastObserved = Math.max(updatedRow.lastObserved, e.lastObserved);
    updatedRow.lastHeard = Math.max(updatedRow.lastHeard, e.lastHeard);
    updatedRow.observed += e.observed;
    updatedRow.heard += e.heard;
    updatedRow.lost += e.lost;
    updatedRow.rssi = util.definedOr(Math.max, updatedRow.rssi, e.rssi);
    updatedRow.snr = util.definedOr(Math.max, updatedRow.snr, e.snr);
    e.mesh_ids?.forEach(id => meshIdSet.add(id));
    e.repeaters.forEach(r => repeaterSet.add(r));
  });
  updatedRow.mesh_ids = [...meshIdSet];
  updatedRow.repeaters = [...repeaterSet];

  await DB.prepare(`
    INSERT OR REPLACE INTO coverage
      (hash, time, lastObserved, lastHeard, observed, heard, lost, rssi, snr, mesh_ids, repeaters, entries)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      updatedRow.hash,
      updatedRow.time,
      updatedRow.lastObserved,
      updatedRow.lastHeard,
      updatedRow.observed,
      updatedRow.heard,
      updatedRow.lost,
      updatedRow.rssi,
      updatedRow.snr,
      JSON.stringify(updatedRow.mesh_ids),
      JSON.stringify(updatedRow.repeaters),
      JSON.stringify(updatedRow.entries)
    ).run();
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  let maxAge = url.searchParams.get('maxAge') ?? DEF_CONSOLIDATE_AGE; // Days
  if (maxAge <= 0)
    maxAge = DEF_CONSOLIDATE_AGE;

  const result = {
    coverage_to_update: 0,
    samples_to_update: 0,
    merged_ok: 0,
    merged_fail: 0,
    merged_skip: 0,
  };
  const now = Date.now();
  const hashToSamples = new Map();

  // Get old samples.
  const { results: samples } = await context.env.DB
    .prepare("SELECT * FROM samples WHERE time < ?")
    .bind(now - (maxAge * util.dayInMillis))
    .all();
  console.log(`Old samples:${samples.length}`);
  result.samples_to_update = samples.length;

  // Build index of old samples - group by 6-digit hash.
  samples.forEach(s => {
    const key = s.hash.substring(0, 6);
    util.pushMap(hashToSamples, key, s);
  });
  console.log(`Coverage to update:${hashToSamples.size}`);
  result.coverage_to_update = hashToSamples.size;

  const mergedKeys = [];
  let mergeCount = 0;

  // Merge old samples into coverage items.
  for (const [k, v] of hashToSamples.entries()) {
    // To prevent hitting request limit, only handle first N.
    // Merge is one Read/Write per call.
    if (++mergeCount > 300)
      break;

    try {
      await mergeCoverage(k, v, context.env.DB);
      result.merged_ok++;
      mergedKeys.push(k);
    } catch (e) {
      console.log(`Merge failed. ${e}`);
      result.merged_fail++;
    }
  }
  result.merged_skip = hashToSamples.size - (result.merged_ok + result.merged_fail);

  // Archive and delete the old samples.
  const cleanupStmts = [];
  mergedKeys.forEach(k => {
    const v = hashToSamples.get(k);
    for (const sample of v) {
      cleanupStmts.push(context.env.DB
        .prepare("INSERT INTO sample_archive (time, data) VALUES (?, ?)")
        .bind(now, JSON.stringify(sample)));
      cleanupStmts.push(context.env.DB
        .prepare("DELETE FROM samples WHERE hash = ?")
        .bind(sample.hash));
    }
  });
  if (cleanupStmts.length > 0)
    await context.env.DB.batch(cleanupStmts);

  return Response.json(result);
}
