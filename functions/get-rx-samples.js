export async function onRequest(context) {
  const { results } = await context.env.DB
    .prepare('SELECT * FROM v_rx_ui')
    .all();

  results.forEach(r => {
    r.repeaters = JSON.parse(r.repeaters);
  });
  return Response.json(results);
}
