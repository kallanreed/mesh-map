// Returns consolidated coverage and sample data.
import * as util from '../content/shared.js';

function addItem(map, id, observed, heard, time) {
  const value = {
    o: observed ? 1 : 0,
    h: heard ? 1 : 0,
    a: Math.round(util.ageInDays(time) * 10) / 10
  };
  const prevValue = map.get(id);

  // If the id doesn't exist, add it.
  if (!prevValue) {
    map.set(id, value);
    return;
  }

  // Update the previous entry in-place.
  // o is 0|1 for "observed" -- prefer observed.
  // h is 0|1 for "heard" -- prefer heard.
  // a is "age in days" -- prefer newest.
  prevValue.o = Math.max(value.o, prevValue.o);
  prevValue.h = Math.max(value.h, prevValue.h);
  prevValue.a = Math.min(value.a, prevValue.a);
}

export async function onRequest(context) {
  const tiles = new Map();
  let cursor = null;

  const { results: coverage } = await context.env.DB
    .prepare("SELECT hash, time, observed, heard FROM coverage").all();
  coverage.forEach(c => {
    addItem(tiles, c.hash, c.observed, c.heard, c.time);
  });

  const { results: samples } = await context.env.DB
    .prepare("SELECT hash, time, repeaters, observed FROM samples").all();
  samples.forEach(s => {
    const id = s.hash.substring(0, 6);
    const path = JSON.parse(s.repeaters || '[]');
    const observed = s.observed;
    const heard = path.length > 0;
    const time = s.time;
    addItem(tiles, id, observed, heard, time);
  });

  return Response.json(Array.from(tiles));
}
