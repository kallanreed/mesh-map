export async function onRequest(context) {
  // Update with to Date.now() to force reload.
  return Response.json({ latest: 1769098745211 });
}