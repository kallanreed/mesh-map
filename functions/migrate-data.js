async function migrateSamples(context) {
  //const store = context.env.SAMPLES;
  //const samplesList = await store.list();

  // // Migration from old key format
  // await Promise.all(samplesList.keys.map(async s => {
  //   const parts = s.name.split('|');
  //   if (parts.length === 3) {
  //     console.log(`${s.name} is old schema`);
  //     const metadata = s.metadata;
  //     const key = `${metadata.lat}|${metadata.lon}`;
  //     await store.put(key, "", {
  //       metadata: metadata,
  //     });
  //     await store.delete(s.name);
  //   }
  // }));

  // // Fix up key consistency
  // await Promise.all(samplesList.keys.map(async s => {
  //   const metadata = s.metadata;
  //   const key = `${metadata.lat.toFixed(4)}|${metadata.lon.toFixed(4)}`;
  //   if (key !== s.name) {
  //     await store.put(key, "", {
  //       metadata: metadata,
  //     });
  //     await store.delete(s.name);
  //   }
  // }));
}

async function migrateRepeaters(context) {
  // const store = context.env.REPEATERS;
  // const repeatersList = await store.list();

  // // Fix up key consistency
  // await Promise.all(repeatersList.keys.map(async r => {
  //   const metadata = r.metadata;
  //   const key = `${metadata.id}|${metadata.lat.toFixed(4)}|${metadata.lon.toFixed(4)}`;
  //   if (key !== r.name) {
  //     await store.put(key, "", {
  //       metadata: metadata
  //     });
  //     await store.delete(r.name);
  //   }
  // }));
}

export async function onRequest(context) {
  await migrateSamples(context);
  await migrateRepeaters(context);

  return new Response('OK');
}
