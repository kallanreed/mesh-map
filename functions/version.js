export async function onRequest(context) {
  // Update with to Date.now() to force reload.
  return Response.json({ latest: 1767549851133 });
}
