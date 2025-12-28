export async function onRequest(context) {
  const url = new URL(context.request.url);
  const after = Number(url.searchParams.get('after') ?? 0);

  const { results } = await context.env.DB
    .prepare(`
      SELECT name, count(hash) as tiles FROM senders
      WHERE time > ? GROUP BY name ORDER BY tiles DESC`)
    .bind(after)
    .all()

  return Response.json(results);
}
