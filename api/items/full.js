import { clean, dispatchWorkflow, getActiveWorkflowRun, getDailyWorkflowLimitStatus, methodAllowed, readBody, requireAuth, sendJson } from "../_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const activeRun = await getActiveWorkflowRun();
    if (activeRun) {
      sendJson(res, 200, {
        queued: true,
        item: null,
        warnings: ["Masih ada workflow generate yang berjalan, jadi dispatch baru tidak dikirim agar tidak membuat video/posting dobel."],
        dispatch: {
          ok: true,
          skipped: true,
          reason: "active_workflow_exists",
          existingRun: activeRun
        }
      });
      return;
    }
    const daily = await getDailyWorkflowLimitStatus();
    if (daily.reached) {
      sendJson(res, 200, {
        queued: false,
        skipped: true,
        item: null,
        warnings: [`Batas generate harian sudah tercapai (${daily.count}/${daily.limit}) untuk ${daily.dateKey}.`],
        daily
      });
      return;
    }
    const dispatch = await dispatchWorkflow({
      topic: clean(body.topic || body.selectedIdea?.topic || ""),
      category: clean(body.category || body.selectedIdea?.category || "random"),
      duration: String(body.durationSec || 90),
      scenes: String(body.sceneCount || 7),
      tts_provider: clean(body.ttsProvider || "openai"),
      image_quality: clean(body.imageQuality || "low"),
      with_clip: "false"
    });
    sendJson(res, 200, {
      queued: true,
      item: null,
      warnings: ["Workflow GitHub Actions sudah dipicu dalam mode hemat gambar + TTS. Refresh galeri beberapa menit lagi untuk melihat video final."],
      dispatch
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}
