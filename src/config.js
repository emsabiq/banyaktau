import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function clean(value) {
  return String(value || "").trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function bool(value) {
  const cleaned = String(value || "").trim().toLowerCase();
  if (!cleaned) return false;
  return !["0", "false", "no", "off"].includes(cleaned);
}

function boolDefault(value, fallback) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? bool(cleaned) : fallback;
}

function trimSlash(value) {
  return clean(value).replace(/\/+$/g, "");
}

export const paths = {
  rootDir,
  dataDir: path.join(rootDir, "data"),
  generatedDir: path.join(rootDir, "generated"),
  imageDir: path.join(rootDir, "generated", "images"),
  audioDir: path.join(rootDir, "generated", "audio"),
  clipDir: path.join(rootDir, "generated", "clips"),
  thumbnailDir: path.join(rootDir, "generated", "thumbnails"),
  videoDir: path.join(rootDir, "generated", "videos"),
  workDir: path.join(rootDir, "generated", "work"),
  publicDir: path.join(rootDir, "public")
};

export function ensureProjectDirs() {
  for (const dir of Object.values(paths)) {
    if (String(dir).startsWith(rootDir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export const config = {
  port: Math.max(1, Math.floor(numberEnv("PORT", 3040))),
  publicBaseUrl: clean(process.env.PUBLIC_BASE_URL),
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: trimSlash(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    storyModel: clean(process.env.STORY_MODEL || "gpt-4.1-mini"),
    imageModel: clean(process.env.IMAGE_MODEL || "gpt-image-1-mini"),
    imageSize: clean(process.env.IMAGE_SIZE || "1024x1536"),
    imageQuality: clean(process.env.IMAGE_QUALITY || "low"),
    ttsModel: clean(process.env.OPENAI_TTS_MODEL || process.env.TTS_MODEL || "gpt-4o-mini-tts"),
    ttsVoice: clean(process.env.OPENAI_TTS_VOICE || process.env.TTS_VOICE || "shimmer"),
    transcribeModel: clean(process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1")
  },
  video: {
    provider: "disabled",
    apiKey: "",
    baseUrl: "",
    endpointMode: "disabled",
    model: "",
    aspectRatio: "9:16",
    resolution: "720p",
    seconds: 0
  },
  facebook: {
    enabled: bool(process.env.FACEBOOK_UPLOAD_ENABLED || process.env.BANYAKTAU_FACEBOOK_UPLOAD_ENABLED),
    graphApiVersion: clean(process.env.GRAPH_API_VERSION || "v25.0"),
    pageId: clean(process.env.BANYAKTAU_FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID),
    accessToken: process.env.BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "",
    userAccessToken: process.env.BANYAKTAU_FACEBOOK_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || "",
    mediaType: clean(process.env.FACEBOOK_MEDIA_TYPE || "reel").toLowerCase(),
    videoState: clean(process.env.FACEBOOK_VIDEO_STATE || "PUBLISHED"),
    titlePrefix: clean(process.env.FACEBOOK_TITLE_PREFIX || "")
  },
  instagram: {
    enabled: bool(process.env.INSTAGRAM_UPLOAD_ENABLED || process.env.BANYAKTAU_INSTAGRAM_UPLOAD_ENABLED),
    igUserId: clean(process.env.BANYAKTAU_INSTAGRAM_IG_USER_ID || process.env.INSTAGRAM_IG_USER_ID),
    accessToken: process.env.BANYAKTAU_INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || "",
    shareToFeed: boolDefault(process.env.INSTAGRAM_SHARE_TO_FEED, true),
    containerPollSeconds: Math.min(60, Math.max(2, numberEnv("INSTAGRAM_CONTAINER_POLL_SECONDS", 6))),
    containerMaxAttempts: Math.min(180, Math.max(5, numberEnv("INSTAGRAM_CONTAINER_MAX_ATTEMPTS", 90))),
    maxDurationSec: Math.max(1, numberEnv("INSTAGRAM_MAX_DURATION_SECONDS", 90))
  },
  youtube: {
    enabled: bool(process.env.YOUTUBE_UPLOAD_ENABLED),
    clientId: clean(process.env.YOUTUBE_CLIENT_ID),
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
    privacyStatus: clean(process.env.YOUTUBE_PRIVACY_STATUS || "public"),
    categoryId: clean(process.env.YOUTUBE_CATEGORY_ID || "27"),
    tags: clean(process.env.YOUTUBE_TAGS || "BanyakTau,Fakta Menarik,Shorts,Pengetahuan").split(",").map((tag) => clean(tag)).filter(Boolean),
    customThumbnailEnabled: boolDefault(process.env.YOUTUBE_CUSTOM_THUMBNAIL_ENABLED, true),
    thumbnailUploadAttempts: Math.min(3, Math.max(1, numberEnv("YOUTUBE_THUMBNAIL_UPLOAD_ATTEMPTS", 1))),
    dailyUploadLimit: Math.max(0, numberEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", 3))
  },
  gemini: {
    apiKey: "",
    baseUrl: ""
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    model: clean(process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2"),
    voiceId: clean(process.env.ELEVENLABS_VOICE_ID || "pFZP5JQG7iQjIQuC4Bku")
  },
  pricing: {
    storyInputUsdPer1MTokens: numberEnv("STORY_INPUT_USD_PER_1M_TOKENS", 0.4),
    storyOutputUsdPer1MTokens: numberEnv("STORY_OUTPUT_USD_PER_1M_TOKENS", 1.6),
    openaiTtsUsdPer1MChars: numberEnv("OPENAI_TTS_USD_PER_1M_CHARS", numberEnv("TTS_USD_PER_1M_CHARS", 15)),
    elevenlabsTtsUsdPer1KChars: numberEnv("ELEVENLABS_TTS_USD_PER_1K_CHARS", 0.1),
    videoUsdPerSecond: 0
  },
  render: {
    fontTitle: clean(process.env.RENDER_TITLE_FONT || "Georgia"),
    fontBody: clean(process.env.RENDER_BODY_FONT || "Segoe UI Semibold"),
    fontMono: clean(process.env.RENDER_MONO_FONT || "Cascadia Code"),
    speechTempo: Math.min(1.3, Math.max(0.9, numberEnv("SPEECH_TEMPO", 1.15)))
  }
};

export function publicConfig() {
  return {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    providers: {
      openai: Boolean(config.openai.apiKey),
      openaiBaseUrl: config.openai.baseUrl,
      elevenlabs: Boolean(config.elevenlabs.apiKey),
      storyModel: config.openai.storyModel,
      imageModel: config.openai.imageModel,
      imageSize: config.openai.imageSize,
      imageQuality: config.openai.imageQuality,
      videoProvider: "disabled",
      videoBaseUrl: "",
      videoEndpointMode: "disabled",
      videoModel: "",
      videoAspectRatio: "9:16",
      videoResolution: "720p",
      videoSeconds: 0,
      videoApiKeySet: false,
      facebookUploadEnabled: config.facebook.enabled,
      facebookPageIdSet: bool(config.facebook.pageId),
      facebookPageTokenSet: bool(config.facebook.accessToken || config.facebook.userAccessToken),
      instagramUploadEnabled: config.instagram.enabled,
      instagramIgUserIdSet: bool(config.instagram.igUserId),
      instagramAccessTokenSet: bool(config.instagram.accessToken),
      youtubeUploadEnabled: config.youtube.enabled,
      youtubeClientIdSet: bool(config.youtube.clientId),
      youtubeRefreshTokenSet: bool(config.youtube.refreshToken),
      geminiApiKeySet: false,
      geminiBaseUrl: "",
      openaiApiKeySet: bool(config.openai.apiKey),
      openaiTtsModel: config.openai.ttsModel,
      openaiTtsVoice: config.openai.ttsVoice,
      openaiTranscribeModel: config.openai.transcribeModel,
      elevenlabsApiKeySet: bool(config.elevenlabs.apiKey),
      elevenlabsModel: config.elevenlabs.model,
      elevenlabsVoiceId: config.elevenlabs.voiceId
    },
    render: config.render,
    pricing: {
      videoUsdPerSecond: 0
    },
    dashboard: {
      productionMode: "images-tts-only",
      pinRequired: true
    }
  };
}

export async function updateRuntimeSettings(input = {}) {
  const updates = {};
  const openaiKey = clean(input.openaiApiKey);
  const openaiBaseUrl = trimSlash(input.openaiBaseUrl);
  const storyModel = clean(input.storyModel);
  const imageModel = clean(input.imageModel);
  const elevenlabsKey = clean(input.elevenlabsApiKey);
  const openaiTtsVoice = clean(input.openaiTtsVoice);
  const openaiTtsModel = clean(input.openaiTtsModel);
  const openaiTranscribeModel = clean(input.openaiTranscribeModel);
  const elevenlabsModel = clean(input.elevenlabsModel);
  const elevenlabsVoiceId = clean(input.elevenlabsVoiceId);
  const speechTempo = Number(input.speechTempo);

  if (openaiKey) updates.OPENAI_API_KEY = openaiKey;
  if (openaiBaseUrl) updates.OPENAI_BASE_URL = openaiBaseUrl;
  if (storyModel) updates.STORY_MODEL = storyModel;
  if (imageModel) updates.IMAGE_MODEL = imageModel;
  if (elevenlabsKey) updates.ELEVENLABS_API_KEY = elevenlabsKey;
  if (openaiTtsVoice) updates.OPENAI_TTS_VOICE = openaiTtsVoice;
  if (openaiTtsModel) updates.OPENAI_TTS_MODEL = openaiTtsModel;
  if (openaiTranscribeModel) updates.OPENAI_TRANSCRIBE_MODEL = openaiTranscribeModel;
  if (elevenlabsModel) updates.ELEVENLABS_MODEL = elevenlabsModel;
  if (elevenlabsVoiceId) updates.ELEVENLABS_VOICE_ID = elevenlabsVoiceId;
  if (Number.isFinite(speechTempo)) updates.SPEECH_TEMPO = String(Math.min(1.3, Math.max(0.9, speechTempo)));

  if (Object.keys(updates).length) {
    await writeEnvUpdates(updates);
    applyConfigUpdates(updates);
  }

  return publicConfig();
}

async function writeEnvUpdates(updates) {
  const envPath = path.join(rootDir, ".env");
  let lines = [];
  try {
    lines = (await fsp.readFile(envPath, "utf8")).split(/\r?\n/);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const name = match[1];
    if (!(name in updates)) return line;
    seen.add(name);
    return `${name}=${updates[name]}`;
  });

  for (const [name, value] of Object.entries(updates)) {
    if (!seen.has(name)) next.push(`${name}=${value}`);
  }

  await fsp.writeFile(envPath, `${next.filter((line, index, arr) => index < arr.length - 1 || line).join("\n")}\n`);
}

function applyConfigUpdates(updates) {
  for (const [name, value] of Object.entries(updates)) process.env[name] = value;
  if (updates.OPENAI_API_KEY !== undefined) config.openai.apiKey = updates.OPENAI_API_KEY;
  if (updates.OPENAI_BASE_URL !== undefined) config.openai.baseUrl = trimSlash(updates.OPENAI_BASE_URL);
  if (updates.STORY_MODEL !== undefined) config.openai.storyModel = updates.STORY_MODEL;
  if (updates.IMAGE_MODEL !== undefined) config.openai.imageModel = updates.IMAGE_MODEL;
  if (updates.OPENAI_TTS_MODEL !== undefined) config.openai.ttsModel = updates.OPENAI_TTS_MODEL;
  if (updates.OPENAI_TTS_VOICE !== undefined) config.openai.ttsVoice = updates.OPENAI_TTS_VOICE;
  if (updates.OPENAI_TRANSCRIBE_MODEL !== undefined) config.openai.transcribeModel = updates.OPENAI_TRANSCRIBE_MODEL;
  if (updates.ELEVENLABS_API_KEY !== undefined) config.elevenlabs.apiKey = updates.ELEVENLABS_API_KEY;
  if (updates.ELEVENLABS_MODEL !== undefined) config.elevenlabs.model = updates.ELEVENLABS_MODEL;
  if (updates.ELEVENLABS_VOICE_ID !== undefined) config.elevenlabs.voiceId = updates.ELEVENLABS_VOICE_ID;
  if (updates.SPEECH_TEMPO !== undefined) config.render.speechTempo = Number(updates.SPEECH_TEMPO);
}
