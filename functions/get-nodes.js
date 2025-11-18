export async function onRequest(context) {
  const sampleStore = context.env.SAMPLES;
  const repeaterStore = context.env.REPEATERS;
  const responseData = {
    samples: [],
    repeaters:[]
  };

  const samplesList = await sampleStore.list();
  samplesList.keys.forEach(s => {
    responseData.samples.push({
      time: s.metadata.time,
      lat: s.metadata.lat,
      lon: s.metadata.lon,
      path: s.metadata.path,
    });
  });

  const repeatersList = await repeaterStore.list();
  repeatersList.keys.forEach(r => {
    responseData.repeaters.push({
      time: r.metadata.time ?? 0,
      id: r.metadata.id,
      name: r.metadata.name,
      lat: r.metadata.lat,
      lon: r.metadata.lon,
      elev: r.metadata.elev ?? 0,
    });
  });

  return new Response(JSON.stringify(responseData));
}
