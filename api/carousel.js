import {
  clean,
  dispatchWorkflow,
  getActiveWorkflowRun,
  getDailyCarouselLimitStatus,
  methodAllowed,
  readBody,
  readRemoteItems,
  requireAuth,
  sendJson
} from "./_utils.js";

const carouselWorkflow = "banyaktau-publish-carousel.yml";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const activeRun = await getActiveWorkflowRun({ workflow: carouselWorkflow });
    if (activeRun) {
      sendJson(res, 200, {
        queued: true,
        skipped: true,
        warnings: ["Masih ada workflow carousel berjalan, jadi carousel baru tidak dikirim agar tidak posting dobel."],
        dispatch: {
          ok: true,
          skipped: true,
          reason: "active_workflow_exists",
          existingRun: activeRun
        }
      });
      return;
    }

    const items = await readRemoteItems();
    const force = true; // Manual UI trigger is always allowed
    const daily = await getDailyCarouselLimitStatus(items);

    const dispatch = await dispatchWorkflow({
      target: clean(body.target || "all"),
      item_id: clean(body.itemId || ""),
      force: force ? "true" : "false",
      regenerate: clean(body.regenerate || "false").toLowerCase() === "true" ? "true" : "false",
      topic: clean(body.topic || ""),
      category: clean(body.category || "random")
    }, { workflow: carouselWorkflow });

    sendJson(res, 200, {
      queued: true,
      warnings: ["Workflow carousel sudah dipicu. IG/TikTok memakai URL publik; Facebook bisa fallback ke upload file lokal."],
      dispatch
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}
