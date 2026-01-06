export async function onRequest(context) {
  const url = new URL(context.request.url);
  const prefix = url.searchParams.get('p') ?? ''

  const { results } = await context.env.DB
    .prepare("SELECT * FROM samples WHERE hash LIKE ?")
    .bind(`${prefix}%`)
    .all()

  results.forEach(r => { r.repeaters = JSON.parse(r.repeaters); });
  return Response.json(results);
}

