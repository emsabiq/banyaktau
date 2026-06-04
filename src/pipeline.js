import { spawnSync } from "node:child_process";
import { generateCarouselAssets } from "./carousel-concept.js";
import { config } from "./config.js";
import { estimateImageUsd, estimateTtsUsd } from "./cost.js";
import { generateElevenLabsSpeech } from "./elevenlabs.js";
import { generateOpenAiSpeech, generateSceneImage, transcribeSpeechSegments } from "./openai.js";
import { renderKnowledgeVideo } from "./render.js";
import { generateThumbnail } from "./thumbnail.js";
import { getItem, listContextItems, saveItem } from "./storage.js";
import { createIdeaRecommendations, createKnowledgeDraft, selectMostNovelIdea } from "./story-engine.js";
import { nowIso } from "./util.js";

export async function generateFullItem(input = {}, options = {}) {
  const warnings = [];
  let payload = { ...input };
  const existingItems = await listContextItems();
  if (!payload.selectedIdea) {
    const ideas = await createIdeaRecommendations({
      seed: payload.topic || "",
      category: payload.category || "random",
      durationSec: payload.durationSec || 90
    }, { existingItems });
    const selectedIdea = selectMostNovelIdea(ideas.ideas || [], existingItems);
    payload = {
      ...payload,
      selectedIdea,
      topic: selectedIdea?.topic || payload.topic || ""
    };
  }

  const item = await createKnowledgeDraft(payload, { existingItems });
  await saveItem(item);
  await ensureImages(item, { warnings, strict: true });
  await ensureAudio(item, { provider: item.input.ttsProvider, warnings, force: true });
  await ensureThumbnail(item, { warnings });
  if (options.withClip || options.requireClip) {
    warnings.push("Clip video AI dimatikan agar biaya hemat. Render memakai gambar + TTS saja.");
  }
  await renderAndPersist(item);
  if (options.withCarousel === true) {
    await ensureCarousel(item, { warnings });
  }
  return { item, warnings };
}

export async function requireItem(id) {
  const item = await getItem(id);
  if (!item) {
    const error = new Error("Item tidak ditemukan.");
    error.status = 404;
    throw error;
  }
  return item;
}

export async function ensureProviderClip(item, options = {}) {
  const error = new Error("Generate clip video AI sudah dimatikan. BanyakTau sekarang hanya memakai gambar + TTS agar hemat biaya.");
  error.status = 410;
  throw error;
}

export async function ensureOptionalClip(item, options = {}) {
  const warnings = options.warnings || [];
  warnings.push("Clip video AI dilewati: mode hemat gambar + TTS aktif.");
}

export async function ensureImages(item, options = {}) {
  if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY wajib diisi untuk generate gambar.");
  const warnings = options.warnings || [];
  const images = [...(item.assets.images || [])];
  const size = item.input.imageSize || config.openai.imageSize;
  const quality = item.input.imageQuality || config.openai.imageQuality;

  for (const scene of item.plan.scenes) {
    const existing = images.find((image) => Number(image.sceneIndex) === Number(scene.index));
    if (existing?.path) continue;
    try {
      const image = await generateImageWithRetry({ item, scene, size, quality });
      const index = images.findIndex((entry) => Number(entry.sceneIndex) === Number(scene.index));
      if (index >= 0) images.splice(index, 1, image);
      else images.push(image);
      item.assets.images = sortByScene(images);
      item.updatedAt = nowIso();
      await saveItem(item);
    } catch (error) {
      const message = `Gambar scene ${scene.index} gagal: ${error.message}`;
      if (options.strict) throw new Error(message);
      warnings.push(message);
    }
  }

  item.assets.images = sortByScene(images);
}

export async function ensureAudio(item, options = {}) {
  const hasWarningSink = Array.isArray(options.warnings);
  const warnings = options.warnings || [];
  const provider = String(options.provider || item.input.ttsProvider || "openai").toLowerCase() === "elevenlabs" ? "elevenlabs" : "openai";
  if (item.assets.audio?.path && !options.force && item.assets.audio.provider === provider) return;

  try {
    const text = narrationText(item);
    item.assets.audio = provider === "elevenlabs"
      ? await generateElevenLabsSpeech({ itemId: item.id, text, filenameSuffix: "elevenlabs-natural" })
      : await generateOpenAiSpeech({ itemId: item.id, text, filenameSuffix: "openai-natural" });
    item.assets.audio.characters = text.length;
    try {
      item.assets.captions = await transcribeSpeechSegments(item.assets.audio.path);
    } catch (error) {
      warnings.push(`Transkripsi subtitle gagal: ${error.message}`);
      item.assets.captions = [];
    }
    item.input.ttsProvider = provider;
    item.cost.ttsUsd = estimateTtsUsd(text.length, provider, config.pricing);
    updateTotalCost(item);
    item.updatedAt = nowIso();
    await saveItem(item);
  } catch (error) {
    if (options.strict) throw error;
    warnings.push(`TTS gagal: ${error.message}`);
    if (!hasWarningSink) throw error;
  }
}

export async function ensureThumbnail(item, options = {}) {
  if (item.assets.thumbnail?.path) return;
  const warnings = options.warnings || [];
  try {
    item.assets.thumbnail = await generateThumbnail(item);
    item.updatedAt = nowIso();
    await saveItem(item);
  } catch (error) {
    warnings.push(`Thumbnail gagal: ${error.message}`);
  }
}

export async function ensureCarousel(item, options = {}) {
  const warnings = options.warnings || [];
  try {
    await generateCarouselAssets(item, { warnings, strict: Boolean(options.strict) });
    updateCarouselCost(item);
    item.updatedAt = nowIso();
    await saveItem(item);
  } catch (error) {
    if (options.strict) throw error;
    warnings.push(`Carousel gagal: ${error.message}`);
  }
}

export async function renderAndPersist(item) {
  assertReadyToRender(item);
  item.assets.video = await renderKnowledgeVideo(item);
  item.status = "rendered";
  item.updatedAt = nowIso();
  await saveItem(item);
  return item;
}

export function assertReadyToRender(item) {
  const imageCount = item.assets.images?.length || 0;
  if (imageCount < item.plan.scenes.length) {
    const error = new Error("Gambar belum lengkap. Generate gambar dulu sampai semua scene siap.");
    error.status = 409;
    throw error;
  }
  if (!item.assets.audio?.path) {
    const error = new Error("Audio TTS belum tersedia. Pilih provider TTS lalu generate suara.");
    error.status = 409;
    throw error;
  }
}

export function ffmpegAvailable() {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true });
  return ffmpeg.status === 0;
}

async function generateImageWithRetry({ item, scene, size, quality }) {
  try {
    return await generateSceneImage({ itemId: item.id, scene, size, quality });
  } catch (error) {
    const safeScene = {
      ...scene,
      imagePrompt: [
        `safe educational illustration about ${item.input.topic}`,
        `scene focus: ${scene.screenText}`,
        "objects, hands, classroom table, museum display, science concept, no people in danger, no medical procedure, no text"
      ].join(", ")
    };
    const image = await generateSceneImage({ itemId: item.id, scene: safeScene, size, quality });
    image.recoveredFrom = error.message;
    return image;
  }
}

function narrationText(item) {
  return item.plan.scenes
    .map((scene) => String(scene.narration || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function updateTotalCost(item) {
  item.cost.totalUsd = Number((
    Number(item.cost.storyUsd || 0)
    + Number(item.cost.imageUsd || 0)
    + Number(item.cost.ttsUsd || 0)
    + Number(item.cost.videoUsd || 0)
  ).toFixed(5));
}

function updateCarouselCost(item) {
  const slideCount = Number(item.carousel?.slideCount || item.assets?.carousels?.length || 0);
  const imageUnitUsd = Number(item.cost?.imageUnitUsd || estimateImageUsd(item.input?.imageSize || config.openai.imageSize, item.input?.imageQuality || config.openai.imageQuality));
  const previousCarouselUsd = Number(item.cost?.carouselImageUsd || 0);
  const currentImageUsd = Number(item.cost?.imageUsd || 0);
  const sceneImageUsd = Number(item.cost?.sceneImageUsd || Math.max(0, currentImageUsd - previousCarouselUsd));
  const carouselImageUsd = Number((slideCount * imageUnitUsd).toFixed(5));

  item.cost.sceneImageUsd = Number(sceneImageUsd.toFixed(5));
  item.cost.carouselImageUsd = carouselImageUsd;
  item.cost.imageUsd = Number((item.cost.sceneImageUsd + carouselImageUsd).toFixed(5));
  updateTotalCost(item);
}

function sortByScene(items) {
  return [...items].sort((a, b) => Number(a.sceneIndex || 0) - Number(b.sceneIndex || 0));
}
