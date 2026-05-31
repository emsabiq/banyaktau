import { ensureProjectDirs } from "./config.js";
import { config } from "./config.js";
import { publishToSocials } from "./facebook.js";
import { generateFullItem } from "./pipeline.js";
import { absolutizeGeneratedUrls, publicBaseUrl, remoteEnabled, uploadGeneratedStateAndAssets } from "./remote.js";
import { mergeMemoryItems, saveItem } from "./storage.js";
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
const withClip = false;

console.log("BanyakTau run started.");
console.log(`Category=${input.category}, duration=${input.durationSec}, scenes=${input.sceneCount}, withClip=${withClip}`);
if (requestedClip) {
  console.log("Clip video AI diminta, tetapi dilewati karena mode hemat gambar + TTS aktif.");
}

if (remoteEnabled()) {
  await importRemoteState();
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
  } catch (error) {
    const message = `Remote upload gagal: ${error.message}`;
    result.warnings.push(message);
    console.warn(message);
    if (boolValue(process.env.BANYAKTAU_STRICT_REMOTE, false)) throw error;
  }
}

console.log(JSON.stringify({
  status: "done",
  id: result.item.id,
  title: result.item.title,
  videoUrl: result.item.assets?.video?.url || "",
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

async function publishSocialsIfEnabled(result) {
  if (!config.facebook.enabled && !config.instagram.enabled && !config.youtube.enabled) return;
  try {
    const item = result.item;
    let published = { ok: false, errors: {} };
    if (config.facebook.enabled || config.instagram.enabled) {
      try {
        published = await publishToSocials({
          videoUrl: item.assets?.video?.url || "",
          title: item.title,
          description: socialDescription(item),
          coverUrl: item.assets?.thumbnail?.url || "",
          durationSec: item.assets?.video?.durationSec || 0
        });
      } catch (error) {
        published.errors = { ...(published.errors || {}), meta: error.message };
      }
    }
    if (config.youtube.enabled) {
      try {
        published.youtube = await publishToYoutube({
          videoPath: item.assets?.video?.path || "",
          title: item.title,
          description: youtubeDescription(item),
          tags: ["BanyakTau", item.input?.category, item.input?.topic].filter(Boolean),
          thumbnailPath: item.assets?.thumbnail?.path || ""
        });
      } catch (error) {
        published.errors = { ...(published.errors || {}), youtube: error.message };
      }
    }
    const publishedAt = new Date().toISOString();
    item.publish = {
      ...(item.publish || {})
    };
    if (published.youtube) item.publish.youtube = { ...published.youtube, publishedAt };
    if (published.facebook) item.publish.facebook = { ...published.facebook, publishedAt };
    if (published.instagram) item.publish.instagram = { ...published.instagram, publishedAt };
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
    await uploadGeneratedStateAndAssets({ item });
    console.log(`Social publish complete: ${publishSummary(published)}`);
  } catch (error) {
    const message = `Social publish gagal: ${error.message}`;
    result.warnings.push(message);
    console.warn(message);
    if (boolValue(process.env.FACEBOOK_STRICT_PUBLISH, false)) throw error;
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
  const points = (item.plan?.importantPoints || [])
    .slice(0, 3)
    .map((point) => `- ${point}`)
    .join("\n");
  return [
    item.plan?.hook || `Ternyata ${item.title} punya fakta yang jarang dibahas.`,
    cleanCaptionLine(item.plan?.summary),
    points ? `Poin penting:\n${points}` : "",
    "BanyakTau membahas sains, sejarah, teknologi, dan fakta sehari-hari dengan singkat.",
    "#BanyakTau #FaktaMenarik #Shorts #Pengetahuan #YouTubeShorts"
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
  if (Object.keys(published.errors || {}).length) rows.push(`errors=${Object.keys(published.errors).join(",")}`);
  return rows.join(" ") || "skipped";
}
