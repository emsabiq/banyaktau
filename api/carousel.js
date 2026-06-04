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

const carouselWorkflow = "banyaktau-carousel.yml";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const [activeGenerateRun, activeCarouselRun] = await Promise.all([
      getActiveWorkflowRun(),
      getActiveWorkflowRun({ workflow: carouselWorkflow })
    ]);
    const activeRun = activeGenerateRun || activeCarouselRun;
    if (activeRun) {
      sendJson(res, 200, {
        queued: true,
        skipped: true,
        warnings: ["Masih ada workflow berjalan, jadi carousel baru tidak dikirim agar tidak posting dobel."],
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
    const force = clean(body.force || "false").toLowerCase() === "true";
    const daily = await getDailyCarouselLimitStatus(items);
    if (!force && daily.reached) {
      sendJson(res, 200, {
        queued: false,
        skipped: true,
        warnings: [`Batas carousel harian sudah tercapai (${daily.count}/${daily.limit}) untuk ${daily.dateKey}.`],
        daily
      });
      return;
    }

    const dispatch = await dispatchWorkflow({
      target: clean(body.target || "all"),
      item_id: clean(body.itemId || ""),
      force: force ? "true" : "false",
      regenerate: clean(body.regenerate || "false").toLowerCase() === "true" ? "true" : "false"
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
