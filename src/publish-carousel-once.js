import fs from "node:fs/promises";
import { config, ensureProjectDirs } from "./config.js";
import { ensureCarousel } from "./pipeline.js";
import { absolutizeGeneratedUrls, publicBaseUrl, remoteEnabled, uploadGeneratedStateAndAssets } from "./remote.js";
import { publishCarouselToFacebook, publishCarouselToInstagram } from "./facebook.js";
import { getItem, listContextItems, listItems, mergeMemoryItems, saveItem } from "./storage.js";
import { createIdeaRecommendations, createKnowledgeDraft, selectMostNovelIdea } from "./story-engine.js";
import { publishCarouselToTikTok } from "./tiktok.js";

const fallbackPublicBaseUrl = "https://emsa.pro/banyaktau";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function boolArg(name, fallback = false) {
  const raw = argValue(name, "");
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function clean(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function carouselImageUrls(item) {
  return (item.assets?.carousels || [])
    .filter((asset) => asset?.url)
    .sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
    .map((asset) => asset.url);
}

function carouselImagePaths(item) {
  return (item.assets?.carousels || [])
    .filter((asset) => asset?.path)
    .sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
    .map((asset) => asset.path);
}

function publicCarouselUrls(item) {
  return carouselImageUrls(item).filter((url) => /^https?:\/\//i.test(String(url || "")));
}

function hasUsablePublicCarousel(item) {
  return publicCarouselUrls(item).length >= 2;
}

async function hasLocalCarouselFiles(item) {
  const assets = item.assets?.carousels || [];
  for (const asset of assets) {
    if (!asset?.path) continue;
    try {
      await fs.access(asset.path);
      return true;
    } catch {
      // Missing old local path from remote state; public URL may still be valid.
    }
  }
  return false;
}

function socialDescription(item) {
  const points = (item.plan?.importantPoints || [])
    .slice(0, 3)
    .map((point) => `- ${point}`)
    .join("\n");
  return [
    item.plan?.hook || `Ternyata ${item.title} punya fakta yang jarang dibahas.`,
    cleanCaptionLine(item.plan?.summary),
    points ? `Intinya:\n${points}` : "",
    "Simpan dulu biar tidak lupa, dan kirim ke teman yang suka fakta unik.",
    "#BanyakTau #FaktaMenarik #Pengetahuan"
  ].filter(Boolean).join("\n\n");
}

function cleanCaptionLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

async function importRemoteItems() {
  const urls = remoteStateUrlCandidates();
  let lastError = "";
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const items = await fetchRemoteItems(url);
        for (const item of items) {
          if (item?.id) await saveItem(item);
        }
        await mergeMemoryItems(items);
        console.log(`Remote state carousel terbaca: ${items.length} item.`);
        return items.length;
      } catch (error) {
        lastError = `${url}: ${error.message}`;
        if (attempt < 3) await sleep(attempt * 1500);
      }
    }
  }
  if (lastError) console.warn(`Remote state carousel tidak bisa dibaca: ${lastError}`);
  return 0;
}

function remoteStateUrlCandidates() {
  const direct = clean(process.env.BANYAKTAU_REMOTE_STATE_URL || process.env.PUBLIC_STATE_URL);
  const bases = [
    publicBaseUrl(),
    config.publicBaseUrl,
    fallbackPublicBaseUrl
  ].map((base) => clean(base).replace(/\/+$/g, "")).filter(Boolean);

  const urls = [
    direct,
    ...bases.map((base) => `${base}/state/items.json`)
  ].filter(Boolean);

  return [...new Set(urls)];
}

async function fetchRemoteItems(url) {
  const target = new URL(url);
  target.searchParams.set("v", String(Date.now()));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(target, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": "banyaktau-carousel-runner" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error("payload bukan array");
    return items;
  } finally {
    clearTimeout(timeout);
  }
}

async function pickItem() {
  const id = clean(argValue("--id", ""));
  if (id) {
    const item = await getItem(id);
    if (!item) throw new Error(`Item tidak ditemukan: ${id}`);
    return item;
  }

  const items = await listItems();
  const item = items.find((entry) => entry?.plan?.scenes?.length || entry?.assets?.carousels?.length);
  if (!item) throw new Error("Belum ada item yang bisa dipakai untuk carousel.");
  return item;
}

async function createCarouselOnlyItem(warnings) {
  const existingItems = await listContextItems();
  const seed = clean(argValue("--topic", process.env.BANYAKTAU_TOPIC || ""));
  const category = clean(argValue("--category", process.env.BANYAKTAU_CATEGORY || "random")) || "random";
  const durationSec = Math.max(45, Number(argValue("--duration", process.env.BANYAKTAU_DURATION || "90")) || 90);
  const sceneCount = Math.max(5, Number(argValue("--scenes", process.env.BANYAKTAU_SCENES || "7")) || 7);
  const imageQuality = clean(argValue("--image-quality", process.env.IMAGE_QUALITY || config.openai.imageQuality));
  const imageSize = clean(argValue("--image-size", process.env.IMAGE_SIZE || config.openai.imageSize));
  const ideas = await createIdeaRecommendations({ seed, category, durationSec }, { existingItems });
  const selectedIdea = selectMostNovelIdea(ideas.ideas || [], existingItems);
  const item = await createKnowledgeDraft({
    topic: selectedIdea?.topic || seed || "fakta unik yang jarang dibahas",
    category: selectedIdea?.category || category,
    selectedIdea,
    durationSec,
    sceneCount,
    ttsProvider: "openai",
    imageQuality,
    imageSize
  }, { existingItems });

  await saveItem(item);
  await mergeMemoryItems([item]);
  warnings.push("Carousel dibuat dari ide baru karena runner tidak menemukan item siap pakai.");
  return item;
}

function resolveTargets(mode) {
  const enabled = enabledCarouselTargets();
  const value = clean(mode || "all").toLowerCase();
  if (!enabled.length || ["none", "off", "false", "0"].includes(value)) return [];
  if (value === "all") return enabled;
  if (["auto", "single", "one"].includes(value)) return enabled.slice(0, 1);
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => enabled.includes(entry));
}

function enabledCarouselTargets() {
  const targets = [];
  if (config.instagram.enabled) targets.push("instagram");
  if (config.facebook.enabled) targets.push("facebook");
  if (config.tiktok.enabled) targets.push("tiktok");
  return targets;
}

async function publishTarget(target, options) {
  if (target === "instagram") return publishCarouselToInstagram(options);
  if (target === "facebook") return publishCarouselToFacebook(options);
  if (target === "tiktok") return publishCarouselToTikTok(options);
  throw new Error(`Target carousel tidak didukung: ${target}`);
}

async function dailyCarouselLimitReached() {
  const limit = Math.max(0, Number(process.env.BANYAKTAU_DAILY_CAROUSEL_LIMIT || "1") || 0);
  if (!limit) return false;
  const [items, workflowCount] = await Promise.all([
    listItems(),
    countSuccessfulWorkflowRunsToday()
  ]);
  const today = localDayKey(new Date());
  const stateCount = items.filter((item) => {
    const carousel = item?.publish?.carousel || {};
    return Object.values(carousel).some((entry) => {
      const publishedAt = entry?.publishedAt;
      return publishedAt && localDayKey(new Date(publishedAt)) === today;
    });
  }).length;
  const count = Math.max(stateCount, workflowCount);
  if (count >= limit) {
    console.log(`Daily carousel limit reached: ${count}/${limit} for ${today} (state=${stateCount}, workflow=${workflowCount}).`);
  }
  return count >= limit;
}

async function countSuccessfulWorkflowRunsToday() {
  const token = process.env.GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const workflow = process.env.BANYAKTAU_CAROUSEL_WORKFLOW_FILE || "banyaktau-publish-carousel.yml";
  if (!token || !repo) return 0;
  try {
    const url = new URL(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`);
    url.searchParams.set("per_page", "50");
    url.searchParams.set("status", "success");
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "banyaktau-carousel-runner"
      },
      cache: "no-store"
    });
    if (!response.ok) return 0;
    const data = await response.json();
    const today = localDayKey(new Date());
    return (data.workflow_runs || []).filter((run) => (
      run.conclusion === "success"
      && ["schedule", "workflow_dispatch"].includes(run.event)
      && localDayKey(new Date(run.created_at)) === today
    )).length;
  } catch (error) {
    console.warn(`Hitung run carousel harian gagal: ${error.message}`);
    return 0;
  }
}

function localDayKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const timeZone = process.env.BANYAKTAU_TIME_ZONE || "Asia/Bangkok";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

async function main() {
  ensureProjectDirs();
  await importRemoteItems();

  const targetMode = clean(argValue("--target", process.env.BANYAKTAU_CAROUSEL_TEST_TARGET || "all")).toLowerCase();
  const targets = resolveTargets(targetMode);
  const force = boolArg("--force", ["1", "true", "yes", "on"].includes(clean(process.env.BANYAKTAU_FORCE_CAROUSEL).toLowerCase()));
  const regenerate = boolArg("--regenerate", false);
  const warnings = [];

  if (!targets.length) {
    console.log(JSON.stringify({ status: "skipped", reason: "no_enabled_carousel_targets", targetMode }, null, 2));
    return;
  }
  // Batasan harian hanya berlaku untuk run otomatis (schedule/cron).
  // Jika dijalankan manual (workflow_dispatch atau lokal), batas harian dilewati secara default.
  const isAutomated = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "schedule";
  if (isAutomated && !force && await dailyCarouselLimitReached()) {
    console.log(JSON.stringify({ status: "skipped", reason: "daily_carousel_limit_reached", targetMode, targets }, null, 2));
    return;
  }

  let item;
  try {
    item = await pickItem();
  } catch (error) {
    warnings.push(error.message);
    item = await createCarouselOnlyItem(warnings);
  }
  if (regenerate || !hasUsablePublicCarousel(item)) {
    await ensureCarousel(item, { warnings, strict: true });
  }

  let publishItem = absolutizeGeneratedUrls(item);
  let remoteReady = hasUsablePublicCarousel(publishItem);
  const needsCarouselUpload = await hasLocalCarouselFiles(item);
  if (remoteEnabled() && (regenerate || needsCarouselUpload || !remoteReady)) {
    try {
      await saveItem(publishItem);
      await mergeMemoryItems([publishItem]);
      await uploadGeneratedStateAndAssets({ item: publishItem });
      remoteReady = hasUsablePublicCarousel(publishItem);
    } catch (error) {
      warnings.push(`Remote upload carousel gagal: ${error.message}`);
      remoteReady = false;
    }
  }

  const imageUrls = remoteReady ? publicCarouselUrls(publishItem) : [];
  const imagePaths = carouselImagePaths(item);
  const published = {};
  const errors = {};

  for (const target of targets) {
    if (target !== "facebook" && imageUrls.length < 2) {
      errors[target] = "URL publik carousel belum siap.";
      continue;
    }
    if (target === "facebook" && Math.max(imageUrls.length, imagePaths.length) < 2) {
      errors[target] = "Minimal 2 gambar carousel belum tersedia.";
      continue;
    }

    try {
      published[target] = await publishTarget(target, {
        imageUrls,
        imagePaths,
        title: publishItem.title,
        description: socialDescription(publishItem)
      });
    } catch (error) {
      errors[target] = error.message;
    }
  }

  const publishedAt = new Date().toISOString();
  publishItem.publish = {
    ...(publishItem.publish || {}),
    carousel: {
      ...(publishItem.publish?.carousel || {})
    }
  };
  for (const [target, result] of Object.entries(published)) {
    publishItem.publish.carousel[target] = { ...result, publishedAt };
  }
  if (Object.keys(errors).length) {
    publishItem.publish.carouselErrors = {
      ...(publishItem.publish.carouselErrors || {}),
      ...errors
    };
  }

  await saveItem(publishItem);
  await mergeMemoryItems([publishItem]);
  if (remoteEnabled()) {
    try {
      await uploadGeneratedStateAndAssets({ item: publishItem });
    } catch (error) {
      warnings.push(`Remote state setelah publish carousel gagal: ${error.message}`);
    }
  }

  console.log(JSON.stringify({
    status: Object.keys(published).length ? "done" : "skipped",
    targetMode,
    targets,
    itemId: publishItem.id,
    title: publishItem.title,
    slideCount: Math.max(imageUrls.length, imagePaths.length),
    published,
    errors,
    warnings
  }, null, 2));
}

main().catch((error) => {
  console.error(`Publish carousel gagal: ${error.stack || error.message}`);
  process.exit(1);
});
