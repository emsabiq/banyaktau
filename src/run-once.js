import { ensureProjectDirs } from "./config.js";
import { config } from "./config.js";
import { publishCarouselToFacebook, publishCarouselToInstagram, publishToFacebook, publishToInstagram } from "./facebook.js";
import { generateFullItem } from "./pipeline.js";
import { absolutizeGeneratedUrls, publicBaseUrl, remoteEnabled, uploadGeneratedStateAndAssets } from "./remote.js";
import { listContextItems, mergeMemoryItems, saveItem } from "./storage.js";
import { publishCarouselToTikTok, publishToTikTok } from "./tiktok.js";
import { publishToYoutube } from "./youtube-publisher.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

ensureProjectDirs();

const input = {
  topic: argValue("--topic", process.env.BANYAKTAU_TOPIC || ""),
  category: argValue("--category", process.env.BANYAKTAU_CATEGORY || "random"),
  tone: argValue("--tone", process.env.BANYAKTAU_TONE || "natural, penasaran, hangat, seperti kreator pengetahuan yang enak didengar"),
  ttsProvider: argValue("--tts-provider", process.env.BANYAKTAU_TTS_PROVIDER || "openai"),
  durationSec: Number(argValue("--duration", process.env.BANYAKTAU_DURATION || "90")),
  sceneCount: Number(argValue("--scenes", process.env.BANYAKTAU_SCENES || "7")),
  imageQuality: argValue("--image-quality", process.env.IMAGE_QUALITY || "low"),
  imageSize: argValue("--image-size", process.env.IMAGE_SIZE || "1024x1536")
};

const requestedClip = boolValue(argValue("--with-clip", process.env.BANYAKTAU_WITH_CLIP || "false"), false);
const carouselPublishTargetsArg = argValue("--carousel-publish-targets", "");
if (carouselPublishTargetsArg) process.env.BANYAKTAU_CAROUSEL_PUBLISH_TARGETS = carouselPublishTargetsArg;
const withClip = false;
const dailyGenerateLimit = Math.max(0, Number(process.env.BANYAKTAU_DAILY_GENERATE_LIMIT || "3") || 0);

console.log("BanyakTau run started.");
console.log(`Category=${input.category}, duration=${input.durationSec}, scenes=${input.sceneCount}, withClip=${withClip}`);
if (requestedClip) {
  console.log("Clip video AI diminta, tetapi dilewati karena mode hemat gambar + TTS aktif.");
}

if (remoteEnabled()) {
  await importRemoteState();
}

if (!boolValue(process.env.BANYAKTAU_FORCE_GENERATE, false) && await dailyGenerationLimitReached()) {
  console.log(JSON.stringify({
    status: "skipped",
    reason: `Batas generate harian tercapai (${dailyGenerateLimit}/hari).`,
    dateKey: localDayKey(new Date()),
    dailyGenerateLimit
  }, null, 2));
  process.exit(0);
}

const result = await generateFullItem(input, { withClip, requireClip: withClip });
if (remoteEnabled()) {
  result.item = absolutizeGeneratedUrls(result.item);
  await mergeMemoryItems([result.item]);
  await saveItem(result.item);
  try {
    await uploadGeneratedStateAndAssets({ item: result.item });
    console.log("Remote upload complete.");
    await publishSocialsIfEnabled(result);
    await publishCarouselIfEnabled(result);
  } catch (error) {
    const message = `Remote upload gagal: ${error.message}`;
    result.warnings.push(message);
    console.warn(message);
    if (config.tiktok.enabled) await publishSocialsIfEnabled(result, { tiktokOnly: true });
    if (boolValue(process.env.BANYAKTAU_STRICT_REMOTE, false)) throw error;
  }
} else if (config.tiktok.enabled) {
  await publishSocialsIfEnabled(result, { tiktokOnly: true });
}

console.log(JSON.stringify({
  status: "done",
  id: result.item.id,
  title: result.item.title,
  videoUrl: result.item.assets?.video?.url || "",
  carouselSlides: result.item.assets?.carousels?.length || 0,
  warnings: result.warnings
}, null, 2));

async function importRemoteState() {
  const base = publicBaseUrl();
  if (!base) return;
  try {
    const remoteItems = await fetchRemoteJson(`${base}/state/items.json?v=${Date.now()}`, []);
    const remoteMemory = await fetchRemoteJson(`${base}/state/memory.json?v=${Date.now()}`, { items: [] });
    for (const item of remoteItems) {
      if (item?.id) await saveItem(item);
    }
    await mergeMemoryItems([
      ...remoteItems,
      ...normalizeMemoryPayload(remoteMemory)
    ]);
  } catch (error) {
    console.warn(`Remote memory lama tidak bisa digabung: ${error.message}`);
  }
}

async function fetchRemoteJson(url, fallback) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return fallback;
  return response.json();
}

function normalizeMemoryPayload(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function publishSocialsIfEnabled(result, options = {}) {
  const tiktokOnly = Boolean(options.tiktokOnly);
  const targets = resolvePublishTargets({ tiktokOnly });
  if (!targets.length) return;
  try {
    const item = result.item;
    let published = { ok: false, errors: {} };
    const publishOptions = {
      videoUrl: item.assets?.video?.url || "",
      title: item.title,
      description: socialDescription(item),
      coverUrl: item.assets?.thumbnail?.url || "",
      durationSec: item.assets?.video?.durationSec || 0
    };
    if (targets.includes("facebook")) {
      try {
        published.facebook = await publishToFacebook(publishOptions);
      } catch (error) {
        published.errors = { ...(published.errors || {}), facebook: error.message };
      }
    }
    if (targets.includes("instagram")) {
      try {
        published.instagram = await publishToInstagram(publishOptions);
      } catch (error) {
        published.errors = { ...(published.errors || {}), instagram: error.message };
      }
    }
    if (targets.includes("youtube")) {
      try {
        if (await youtubeDailyLimitReached()) {
          published.errors = { ...(published.errors || {}), youtube: `Batas upload YouTube harian tercapai (${config.youtube.dailyUploadLimit}/hari).` };
        } else {
          published.youtube = await publishToYoutube({
            videoPath: item.assets?.video?.path || "",
            title: item.title,
            description: youtubeDescription(item),
            tags: ["BanyakTau", item.input?.category, item.input?.topic].filter(Boolean),
            thumbnailPath: item.assets?.thumbnail?.path || ""
          });
        }
      } catch (error) {
        published.errors = { ...(published.errors || {}), youtube: error.message };
      }
    }
    if (targets.includes("tiktok")) {
      try {
        published.tiktok = await publishToTikTok({
          videoUrl: item.assets?.video?.url || "",
          videoPath: item.assets?.video?.path || "",
          caption: socialDescription(item)
        });
      } catch (error) {
        published.errors = { ...(published.errors || {}), tiktok: error.message };
      }
    }
    const publishedAt = new Date().toISOString();
    item.publish = {
      ...(item.publish || {}),
      policy: {
        mode: publishTargetMode(),
        targets,
        onePerRun: targets.length === 1
      }
    };
    if (published.youtube) item.publish.youtube = { ...published.youtube, publishedAt };
    if (published.facebook) item.publish.facebook = { ...published.facebook, publishedAt };
    if (published.instagram) item.publish.instagram = { ...published.instagram, publishedAt };
    if (published.tiktok) item.publish.tiktok = { ...published.tiktok, publishedAt };
    if (Object.keys(published.errors || {}).length) {
      item.publish.errors = {
        ...(item.publish.errors || {}),
        ...published.errors
      };
      for (const [platform, message] of Object.entries(published.errors)) {
        result.warnings.push(`${platform} publish gagal: ${message}`);
      }
    }
    await saveItem(item);
    await mergeMemoryItems([item]);
    if (remoteEnabled()) {
      try {
        await uploadGeneratedStateAndAssets({ item });
      } catch (error) {
        const message = `Remote state setelah publish gagal: ${error.message}`;
        result.warnings.push(message);
        console.warn(message);
      }
    }
    console.log(`Social publish complete: ${publishSummary(published)}`);
  } catch (error) {
    const message = `Social publish gagal: ${error.message}`;
    result.warnings.push(message);
    console.warn(message);
    if (boolValue(process.env.FACEBOOK_STRICT_PUBLISH, false)) throw error;
  }
}

async function publishCarouselIfEnabled(result) {
  const targets = resolveCarouselPublishTargets();
  if (!targets.length) return;
  const item = result.item;
  const imageUrls = carouselImageUrls(item);
  if (imageUrls.length < 2) {
    result.warnings.push("Carousel publish dilewati: minimal 2 URL gambar publik belum tersedia.");
    return;
  }

  const published = { errors: {} };
  const options = {
    imageUrls,
    title: item.title,
    description: socialDescription(item)
  };
  if (targets.includes("instagram")) {
    try {
      published.instagram = await publishCarouselToInstagram(options);
    } catch (error) {
      published.errors.instagram = error.message;
    }
  }
  if (targets.includes("facebook")) {
    try {
      published.facebook = await publishCarouselToFacebook(options);
    } catch (error) {
      published.errors.facebook = error.message;
    }
  }
  if (targets.includes("tiktok")) {
    try {
      published.tiktok = await publishCarouselToTikTok(options);
    } catch (error) {
      published.errors.tiktok = error.message;
    }
  }

  const publishedAt = new Date().toISOString();
  item.publish = {
    ...(item.publish || {}),
    carouselPolicy: {
      mode: carouselPublishTargetMode(),
      targets
    },
    carousel: {
      ...(item.publish?.carousel || {})
    }
  };
  if (published.instagram) item.publish.carousel.instagram = { ...published.instagram, publishedAt };
  if (published.facebook) item.publish.carousel.facebook = { ...published.facebook, publishedAt };
  if (published.tiktok) item.publish.carousel.tiktok = { ...published.tiktok, publishedAt };
  if (Object.keys(published.errors).length) {
    item.publish.carouselErrors = {
      ...(item.publish.carouselErrors || {}),
      ...published.errors
    };
    for (const [platform, message] of Object.entries(published.errors)) {
      result.warnings.push(`${platform} carousel publish gagal: ${message}`);
    }
  }

  await saveItem(item);
  await mergeMemoryItems([item]);
  if (remoteEnabled()) {
    try {
      await uploadGeneratedStateAndAssets({ item });
    } catch (error) {
      const message = `Remote state setelah publish carousel gagal: ${error.message}`;
      result.warnings.push(message);
      console.warn(message);
    }
  }
  console.log(`Carousel publish complete: ${carouselPublishSummary(published)}`);
}

async function dailyGenerationLimitReached() {
  if (!dailyGenerateLimit) return false;
  const [items, workflowCount] = await Promise.all([
    mergeKnownItems(),
    countSuccessfulWorkflowRunsToday()
  ]);
  const today = localDayKey(new Date());
  const stateCount = items.filter((entry) => {
    if (!entry?.assets?.video?.url && entry?.status !== "rendered" && !entry?.videoUrl) return false;
    const generatedAt = entry.createdAt || entry.updatedAt;
    return generatedAt && localDayKey(new Date(generatedAt)) === today;
  }).length;
  const count = Math.max(stateCount, workflowCount);
  if (count >= dailyGenerateLimit) {
    console.log(`Daily generate limit reached: ${count}/${dailyGenerateLimit} for ${today} (state=${stateCount}, workflow=${workflowCount}).`);
  }
  return count >= dailyGenerateLimit;
}

async function countSuccessfulWorkflowRunsToday() {
  const token = process.env.GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const workflow = process.env.BANYAKTAU_WORKFLOW_FILE || "banyaktau-generate.yml";
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
        "User-Agent": "banyaktau-runner"
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
    console.warn(`Hitung run GitHub harian gagal: ${error.message}`);
    return 0;
  }
}

function publishTargetMode() {
  return String(process.env.BANYAKTAU_PUBLISH_TARGETS || process.env.BANYAKTAU_PUBLISH_TARGET || "auto")
    .trim()
    .toLowerCase();
}

function carouselPublishTargetMode() {
  return String(process.env.BANYAKTAU_CAROUSEL_PUBLISH_TARGETS || "none")
    .trim()
    .toLowerCase();
}

function resolvePublishTargets(options = {}) {
  if (options.tiktokOnly) return config.tiktok.enabled ? ["tiktok"] : [];
  const enabled = enabledPublishTargets();
  const mode = publishTargetMode();
  if (!enabled.length || ["none", "off", "false", "0"].includes(mode)) return [];
  if (mode === "all") return enabled;
  if (mode === "auto" || mode === "single" || mode === "one") return enabled.slice(0, 1);

  const requested = mode
    .split(/[\s,]+/)
    .map((target) => target.trim())
    .filter(Boolean);
  const selected = requested.filter((target) => enabled.includes(target));
  return selected.length ? selected : enabled.slice(0, 1);
}

function enabledPublishTargets() {
  const targets = [];
  if (config.tiktok.enabled) targets.push("tiktok");
  if (config.youtube.enabled) targets.push("youtube");
  if (config.instagram.enabled) targets.push("instagram");
  if (config.facebook.enabled) targets.push("facebook");
  return targets;
}

function resolveCarouselPublishTargets() {
  const enabled = enabledCarouselTargets();
  const mode = carouselPublishTargetMode();
  if (!enabled.length || ["none", "off", "false", "0", ""].includes(mode)) return [];
  if (mode === "all") return enabled;
  if (mode === "auto" || mode === "single" || mode === "one") return enabled.slice(0, 1);

  const requested = mode
    .split(/[\s,]+/)
    .map((target) => target.trim())
    .filter(Boolean);
  return requested.filter((target) => enabled.includes(target));
}

function enabledCarouselTargets() {
  const targets = [];
  if (config.instagram.enabled) targets.push("instagram");
  if (config.facebook.enabled) targets.push("facebook");
  if (config.tiktok.enabled) targets.push("tiktok");
  return targets;
}

function carouselImageUrls(item) {
  return (item.assets?.carousels || [])
    .filter((asset) => asset?.url)
    .sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
    .map((asset) => asset.url);
}

async function youtubeDailyLimitReached() {
  const limit = Number(config.youtube.dailyUploadLimit || 0);
  if (!limit) return false;
  const items = await mergeKnownItems();
  const today = dayKey(new Date());
  const count = items.filter((entry) => {
    const publishedAt = entry?.publish?.youtube?.publishedAt;
    return publishedAt && dayKey(new Date(publishedAt)) === today;
  }).length;
  return count >= limit;
}

async function mergeKnownItems() {
  try {
    const localItems = await listContextItems();
    return Array.isArray(localItems) ? localItems : [];
  } catch {
    return [];
  }
}

function dayKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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

function socialDescription(item) {
  const points = (item.plan?.importantPoints || [])
    .slice(0, 3)
    .map((point) => `- ${point}`)
    .join("\n");
  const summary = cleanCaptionLine(item.plan?.summary);
  const question = socialQuestion(item);
  return [
    item.plan?.hook || `Ternyata ${item.title} punya fakta yang jarang dibahas.`,
    summary,
    points ? `Intinya:\n${points}` : "",
    question,
    "Simpan dulu biar tidak lupa, dan kirim ke teman yang suka fakta unik.",
    "#BanyakTau #FaktaMenarik #TahukahKamu #Pengetahuan #Sains #Sejarah #EdukasiRingan #ReelsIndonesia"
  ].filter(Boolean).join("\n\n");
}

function youtubeDescription(item) {
  return [
    item.title,
    item.plan?.hook || `Ternyata ${item.title} punya fakta yang jarang dibahas.`,
    cleanCaptionLine(item.plan?.summary),
    "Video pengetahuan singkat tentang fakta menarik, sains, sejarah, teknologi, dan hal sehari-hari.",
    "#BanyakTau #FaktaMenarik #Pengetahuan"
  ].filter(Boolean).join("\n\n");
}

function cleanCaptionLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function socialQuestion(item) {
  const topic = cleanCaptionLine(item.input?.topic || item.title).replace(/[?.!]+$/g, "");
  if (!topic) return "Menurut kamu, fakta mana yang paling bikin kaget?";
  return `Menurut kamu, bagian paling menarik dari ${topic} apa? Tulis di komentar.`;
}

function publishSummary(published) {
  const rows = [];
  if (published.youtube) rows.push(`youtube=${published.youtube.url || published.youtube.videoId || "ok"}`);
  if (published.facebook) rows.push(`facebook=${published.facebook.url || published.facebook.videoId || "ok"}`);
  if (published.instagram) rows.push(`instagram=${published.instagram.url || published.instagram.mediaId || "ok"}`);
  if (published.tiktok) rows.push(`tiktok=${published.tiktok.publishId || published.tiktok.mode || "ok"}`);
  if (Object.keys(published.errors || {}).length) rows.push(`errors=${Object.keys(published.errors).join(",")}`);
  return rows.join(" ") || "skipped";
}

function carouselPublishSummary(published) {
  const rows = [];
  if (published.instagram) rows.push(`instagram=${published.instagram.url || published.instagram.mediaId || "ok"}`);
  if (published.facebook) rows.push(`facebook=${published.facebook.url || published.facebook.postId || "ok"}`);
  if (published.tiktok) rows.push(`tiktok=${published.tiktok.publishId || published.tiktok.mode || "ok"}`);
  if (Object.keys(published.errors || {}).length) rows.push(`errors=${Object.keys(published.errors).join(",")}`);
  return rows.join(" ") || "skipped";
}
