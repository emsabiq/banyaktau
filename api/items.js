import { methodAllowed, normalizeRemoteItemUrls, readRemoteItems, requireAuth, sendJson } from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;
  const items = normalizeRemoteItemUrls(await readRemoteItems());
  sendJson(res, 200, {
    items: items.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
  });
}
