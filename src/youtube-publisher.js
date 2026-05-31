import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const videoUploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";
const thumbnailUploadUrl = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const maxThumbnailBytes = 2 * 1024 * 1024;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function assertYoutubeConfig() {
  const missing = [];
  if (!config.youtube.enabled) missing.push("YOUTUBE_UPLOAD_ENABLED=true");
  if (!config.youtube.clientId) missing.push("YOUTUBE_CLIENT_ID");
  if (!config.youtube.clientSecret) missing.push("YOUTUBE_CLIENT_SECRET");
  if (!config.youtube.refreshToken) missing.push("YOUTUBE_REFRESH_TOKEN");
  if (missing.length) throw new Error(`Config YouTube belum lengkap: ${missing.join(", ")}`);
}

function normalizeTitle(value) {
  return clean(value).slice(0, 100) || "BanyakTau";
}

function normalizeDescription(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, 5000);
}

function normalizePrivacyStatus(value) {
  const privacy = clean(value).toLowerCase();
  return ["public", "unlisted", "private"].includes(privacy) ? privacy : "public";
}

function normalizeTags(tags = []) {
  const rows = Array.isArray(tags) ? tags : String(tags || "").split(",");
  return [...new Set(rows.map((tag) => clean(tag)).filter(Boolean))].slice(0, 20);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const detail = data.error_description || data.error?.message || data.error || data.raw || response.statusText;
    throw new Error(`${detail} [HTTP ${response.status}]`);
  }
  return { response, data };
}

export async function getYoutubeAccessToken() {
  assertYoutubeConfig();
  const body = new URLSearchParams({
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    refresh_token: config.youtube.refreshToken,
    grant_type: "refresh_token"
  });
  const { data } = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!data.access_token) throw new Error("Google tidak mengembalikan access token YouTube.");
  return data.access_token;
}

async function setYoutubeThumbnail({ videoId, thumbnailPath, accessToken }) {
  if (!videoId || !thumbnailPath) return { ok: false, skipped: true, error: "" };
  let stat;
  try {
    stat = await fsp.stat(thumbnailPath);
  } catch (error) {
    return { ok: false, error: `Thumbnail tidak ditemukan: ${error.message}` };
  }
  if (!stat.size) return { ok: false, error: "Thumbnail kosong." };
  if (stat.size > maxThumbnailBytes) return { ok: false, error: `Thumbnail melebihi 2MB (${stat.size} bytes).` };

  let lastError = null;
  for (let attempt = 1; attempt <= config.youtube.thumbnailUploadAttempts; attempt += 1) {
    try {
      const url = new URL(thumbnailUploadUrl);
      url.searchParams.set("videoId", videoId);
      url.searchParams.set("uploadType", "media");
      await fetchJson(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "image/jpeg",
          "Content-Length": String(stat.size)
        },
        body: fs.createReadStream(thumbnailPath),
        duplex: "half"
      });
      return { ok: true, error: "" };
    } catch (error) {
      lastError = error;
      if (attempt < config.youtube.thumbnailUploadAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
  }
  return { ok: false, error: lastError?.message || "Upload thumbnail YouTube gagal." };
}

export async function publishToYoutube({ videoPath, title, description, tags = [], thumbnailPath }) {
  const accessToken = await getYoutubeAccessToken();
  const stat = await fsp.stat(videoPath);
  const metadata = {
    snippet: {
      title: normalizeTitle(title),
      description: normalizeDescription(description),
      categoryId: config.youtube.categoryId,
      tags: normalizeTags([...config.youtube.tags, ...tags])
    },
    status: {
      privacyStatus: normalizePrivacyStatus(config.youtube.privacyStatus),
      selfDeclaredMadeForKids: false
    }
  };

  const startUrl = new URL(videoUploadUrl);
  startUrl.searchParams.set("uploadType", "resumable");
  startUrl.searchParams.set("part", "snippet,status");
  const start = await fetch(startUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(stat.size),
      "X-Upload-Content-Type": "video/mp4"
    },
    body: JSON.stringify(metadata)
  });
  const sessionUrl = start.headers.get("location");
  if (!start.ok || !sessionUrl) {
    const detail = await start.text();
    throw new Error(`YouTube upload session gagal: ${detail || start.statusText}`);
  }

  const uploaded = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size)
    },
    body: fs.createReadStream(videoPath),
    duplex: "half"
  });
  const uploadText = await uploaded.text();
  let uploadData = {};
  try {
    uploadData = uploadText ? JSON.parse(uploadText) : {};
  } catch {
    uploadData = { raw: uploadText };
  }
  if (!uploaded.ok) {
    throw new Error(`YouTube video upload gagal: ${uploadData.error?.message || uploadData.raw || uploaded.statusText}`);
  }
  const videoId = clean(uploadData.id);
  if (!videoId) throw new Error("YouTube upload selesai tetapi video id kosong.");

  const thumbnail = config.youtube.customThumbnailEnabled
    ? await setYoutubeThumbnail({ videoId, thumbnailPath, accessToken })
    : { ok: false, skipped: true, error: "" };

  return {
    ok: true,
    type: "youtube_video",
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    privacyStatus: metadata.status.privacyStatus,
    title: metadata.snippet.title,
    customThumbnail: Boolean(thumbnail.ok),
    thumbnailError: thumbnail.ok || thumbnail.skipped ? "" : thumbnail.error
  };
}
