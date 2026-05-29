import express from "express";
import { ensureProjectDirs, paths, publicConfig, updateRuntimeSettings } from "./config.js";
import {
  assertReadyToRender,
  ensureAudio,
  ensureImages,
  ffmpegAvailable,
  generateFullItem,
  renderAndPersist,
  requireItem
} from "./pipeline.js";
import { listItems, saveItem } from "./storage.js";
import { createIdeaRecommendations, createKnowledgeDraft } from "./story-engine.js";
import { nowIso } from "./util.js";

ensureProjectDirs();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(paths.publicDir));
app.use("/generated", express.static(paths.generatedDir));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    config: publicConfig(),
    tools: { ffmpeg: ffmpegAvailable() }
  });
});

app.use("/api", requireDashboardPin);

app.get("/api/items", async (_req, res, next) => {
  try {
    res.json({ items: await listItems() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (_req, res, next) => {
  try {
    res.json({
      config: publicConfig(),
      items: await listItems(),
      activeRun: null,
      recentRuns: []
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ideas", async (req, res, next) => {
  try {
    res.json(await createIdeaRecommendations(req.body || {}, { existingItems: await listItems() }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings", async (req, res, next) => {
  try {
    res.json({ config: await updateRuntimeSettings(req.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/items/:id", async (req, res, next) => {
  try {
    res.json({ item: await requireItem(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/items", async (req, res, next) => {
  try {
    const item = await createKnowledgeDraft(req.body || {}, { existingItems: await listItems() });
    await saveItem(item);
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/full", async (req, res, next) => {
  try {
    res.json(await generateFullItem(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/images", async (req, res, next) => {
  try {
    const item = await requireItem(req.params.id);
    await ensureImages(item, { strict: true });
    item.updatedAt = nowIso();
    await saveItem(item);
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/tts", async (req, res, next) => {
  try {
    const item = await requireItem(req.params.id);
    await ensureAudio(item, { provider: req.body?.provider || item.input.ttsProvider, force: true });
    item.updatedAt = nowIso();
    await saveItem(item);
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/clip", async (req, res, next) => {
  try {
    const error = new Error("Generate clip video AI sudah dimatikan. BanyakTau sekarang hanya memakai gambar + TTS agar hemat biaya.");
    error.status = 410;
    throw error;
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/render", async (req, res, next) => {
  try {
    const item = await requireItem(req.params.id);
    const warnings = [];
    if (req.body?.ensureAssets !== false) {
      await ensureImages(item, { warnings, strict: true });
      await ensureAudio(item, { provider: req.body?.provider || item.input.ttsProvider, warnings });
    }
    assertReadyToRender(item);
    await renderAndPersist(item);
    res.json({ item, warnings });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.message || "Server error" });
});

app.listen(publicConfig().port, () => {
  console.log(`BanyakTau Video Studio running at http://localhost:${publicConfig().port}`);
});

function requireDashboardPin(req, res, next) {
  const expected = String(process.env.AUTO_DASHBOARD_PIN || "123456").trim();
  const provided = String(req.headers["x-dashboard-pin"] || req.query.pin || "").trim();
  if (!expected || provided === expected) return next();
  res.status(401).json({ error: "PIN dashboard tidak valid." });
}
