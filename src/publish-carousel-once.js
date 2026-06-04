import { config, ensureProjectDirs } from "./config.js";
import { ensureCarousel } from "./pipeline.js";
import { absolutizeGeneratedUrls, publicBaseUrl, remoteEnabled, uploadGeneratedStateAndAssets } from "./remote.js";
import { publishCarouselToFacebook, publishCarouselToInstagram } from "./facebook.js";
import { getItem, listItems, mergeMemoryItems, saveItem } from "./storage.js";
import { publishCarouselToTikTok } from "./tiktok.js";

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
  const base = publicBaseUrl();
  if (!base) return 0;
  try {
    const response = await fetch(`${base}/state/items.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return 0;
    const items = await response.json();
    if (!Array.isArray(items)) return 0;
    for (const item of items) {
      if (item?.id) await saveItem(item);
    }
    await mergeMemoryItems(items);
    return items.length;
  } catch (error) {
    console.warn(`Remote state carousel tidak bisa dibaca: ${error.message}`);
    return 0;
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
  const items = await listItems();
  const today = localDayKey(new Date());
  const count = items.filter((item) => {
    const carousel = item?.publish?.carousel || {};
    return Object.values(carousel).some((entry) => {
      const publishedAt = entry?.publishedAt;
      return publishedAt && localDayKey(new Date(publishedAt)) === today;
    });
  }).length;
  if (count >= limit) {
    console.log(`Daily carousel limit reached: ${count}/${limit} for ${today}.`);
  }
  return count >= limit;
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
  if (!force && await dailyCarouselLimitReached()) {
    console.log(JSON.stringify({ status: "skipped", reason: "daily_carousel_limit_reached", targetMode, targets }, null, 2));
    return;
  }

  const item = await pickItem();
  if (regenerate || !hasUsablePublicCarousel(item)) {
    await ensureCarousel(item, { warnings, strict: true });
  }

  let publishItem = absolutizeGeneratedUrls(item);
  let remoteReady = hasUsablePublicCarousel(publishItem);
  if (remoteEnabled() && (regenerate || !remoteReady)) {
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
