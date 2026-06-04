import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

const apiBaseUrl = "https://open.tiktokapis.com";
const oauthTokenUrl = `${apiBaseUrl}/v2/oauth/token/`;

function apiUrl(pathName) {
  return `${apiBaseUrl}${pathName}`;
}

function clean(value) {
  return String(value || "").trim();
}

function applyTokens(data) {
  if (data.access_token) {
    process.env.TIKTOK_ACCESS_TOKEN = data.access_token;
    config.tiktok.accessToken = data.access_token;
  }
  if (data.refresh_token) {
    process.env.TIKTOK_REFRESH_TOKEN = data.refresh_token;
    config.tiktok.refreshToken = data.refresh_token;
  }
  if (data.open_id) {
    process.env.TIKTOK_OPEN_ID = data.open_id;
    config.tiktok.openId = data.open_id;
  }
  if (data.scope) {
    process.env.TIKTOK_SCOPE = data.scope;
    config.tiktok.scope = data.scope;
  }
  return data;
}

function assertTikTokAppConfig() {
  const missing = [];
  if (!config.tiktok.clientKey) missing.push("TIKTOK_CLIENT_KEY");
  if (!config.tiktok.clientSecret) missing.push("TIKTOK_CLIENT_SECRET");
  if (missing.length) throw new Error(`Config TikTok belum lengkap: ${missing.join(", ")}`);
}

function assertTikTokPublishConfig() {
  if (config.tiktok.paused) throw new Error("TIKTOK_UPLOAD_PAUSED=true.");
  if (!config.tiktok.enabled) throw new Error("TIKTOK_UPLOAD_ENABLED=true wajib diisi untuk publish TikTok.");
  assertTikTokAppConfig();
  if (!config.tiktok.accessToken && !config.tiktok.refreshToken) {
    throw new Error("TIKTOK_ACCESS_TOKEN atau TIKTOK_REFRESH_TOKEN wajib diisi.");
  }
}

function parseTikTokError(data = {}, fallback = "") {
  const apiError = typeof data.error === "object" && data.error ? data.error : {};
  const code = clean(data.error_code || apiError.code || (typeof data.error === "string" ? data.error : "") || data.code);
  const message = clean(data.error_description || apiError.message || data.message || data.raw || fallback);
  const logId = clean(data.log_id || apiError.log_id);
  return { code, message, logId };
}

function makeTikTokError({ data, prefix, fallback, status }) {
  const { code, message, logId } = parseTikTokError(data, fallback);
  const error = new Error(`${prefix}: ${message || fallback}${code ? ` [${code}]` : ""}${logId ? ` log_id=${logId}` : ""}${status ? ` [HTTP ${status}]` : ""}`);
  error.apiCode = code;
  error.apiError = data;
  return error;
}

async function readJsonResponse(response, fallbackPrefix) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text || fallbackPrefix };
  }
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache"
    },
    body: new URLSearchParams(values)
  });
  const data = await readJsonResponse(response, "TikTok OAuth response");
  if (!response.ok) {
    throw makeTikTokError({
      data,
      prefix: "TikTok OAuth request gagal",
      fallback: response.statusText,
      status: response.status
    });
  }
  return data;
}

async function postJson(pathName, body, accessToken = config.tiktok.accessToken) {
  const response = await fetch(apiUrl(pathName), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body || {})
  });
  const data = await readJsonResponse(response, "TikTok API response");
  if (!response.ok || (data.error?.code && data.error.code !== "ok")) {
    throw makeTikTokError({
      data,
      prefix: "TikTok API request gagal",
      fallback: response.statusText,
      status: response.ok ? "" : response.status
    });
  }
  return data;
}

export async function exchangeTikTokCode({ code, redirectUri = config.tiktok.redirectUri }) {
  assertTikTokAppConfig();
  if (!code) throw new Error("TikTok authorization code kosong.");
  if (!redirectUri) throw new Error("TIKTOK_REDIRECT_URI wajib sama dengan callback yang dipakai login.");

  return applyTokens(await postForm(oauthTokenUrl, {
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  }));
}

export async function refreshTikTokAccessToken() {
  assertTikTokAppConfig();
  if (!config.tiktok.refreshToken) throw new Error("TIKTOK_REFRESH_TOKEN belum diisi.");

  return applyTokens(await postForm(oauthTokenUrl, {
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: "refresh_token",
    refresh_token: config.tiktok.refreshToken
  }));
}

export async function ensureTikTokAccessToken({ forceRefresh = false } = {}) {
  assertTikTokAppConfig();
  if (!config.tiktok.accessToken && !config.tiktok.refreshToken) {
    throw new Error("TIKTOK_ACCESS_TOKEN atau TIKTOK_REFRESH_TOKEN wajib diisi.");
  }
  if (forceRefresh || config.tiktok.refreshToken) {
    try {
      await refreshTikTokAccessToken();
    } catch (error) {
      if (!config.tiktok.accessToken) throw error;
      console.warn(`Refresh token TikTok dilewati: ${error.message}`);
    }
  }
  return config.tiktok.accessToken;
}

export async function queryTikTokCreatorInfo() {
  const accessToken = await ensureTikTokAccessToken();
  const data = await postJson("/v2/post/publish/creator_info/query/", {}, accessToken);
  return data.data || {};
}

function normalizeCaption(value) {
  return String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2200);
}

function normalizePhotoTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function pickPrivacyLevel(options = []) {
  const values = options.map((item) => clean(item)).filter(Boolean);
  const desired = config.tiktok.privacyLevel || "SELF_ONLY";
  if (values.includes(desired)) return desired;
  if (values.includes("SELF_ONLY")) return "SELF_ONLY";
  return values[0] || desired;
}

function fileUploadSourceInfo(stat) {
  if (!stat?.size) throw new Error("File video TikTok kosong atau tidak terbaca.");
  const defaultChunkSize = 10 * 1000 * 1000;
  const chunkSize = stat.size <= 64 * 1000 * 1000 ? stat.size : defaultChunkSize;
  return {
    source: "FILE_UPLOAD",
    video_size: stat.size,
    chunk_size: chunkSize,
    total_chunk_count: Math.max(1, Math.ceil(stat.size / chunkSize))
  };
}

async function uploadVideoFile(uploadUrl, videoPath, stat) {
  const { chunk_size: chunkSize, total_chunk_count: totalChunkCount } = fileUploadSourceInfo(stat);

  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const end = index === totalChunkCount - 1 ? stat.size - 1 : Math.min(start + chunkSize, stat.size) - 1;
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`
      },
      body: fs.createReadStream(videoPath, { start, end }),
      duplex: "half"
    });
    if (!response.ok) {
      const data = await readJsonResponse(response, "TikTok upload response");
      throw makeTikTokError({
        data,
        prefix: "Upload file TikTok gagal",
        fallback: response.statusText,
        status: response.status
      });
    }
  }
}

function isUrlOwnershipError(error) {
  return String(error?.apiCode || error?.message || "").includes("url_ownership_unverified");
}

function isUnauditedDirectPostError(error) {
  return String(error?.apiCode || error?.message || "").includes("unaudited_client_can_only_post_to_private_accounts");
}

async function publishDirect({ videoUrl, videoPath, caption, source = "PULL_FROM_URL" }) {
  const creator = await queryTikTokCreatorInfo();
  const privacyLevel = pickPrivacyLevel(creator.privacy_level_options || []);
  const stat = source === "FILE_UPLOAD" ? await fsp.stat(videoPath) : null;
  const data = await postJson("/v2/post/publish/video/init/", {
    post_info: {
      title: normalizeCaption(caption),
      privacy_level: privacyLevel,
      disable_duet: Boolean(config.tiktok.disableDuet || creator.duet_disabled),
      disable_comment: Boolean(config.tiktok.disableComment || creator.comment_disabled),
      disable_stitch: Boolean(config.tiktok.disableStitch || creator.stitch_disabled),
      video_cover_timestamp_ms: config.tiktok.coverTimestampMs
    },
    source_info: source === "FILE_UPLOAD"
      ? fileUploadSourceInfo(stat)
      : {
        source: "PULL_FROM_URL",
        video_url: videoUrl
      }
  });

  if (source === "FILE_UPLOAD") {
    const uploadUrl = data.data?.upload_url || "";
    if (!uploadUrl) throw new Error("TikTok tidak mengembalikan upload_url untuk file upload.");
    await uploadVideoFile(uploadUrl, videoPath, stat);
  }

  return {
    ok: Boolean(data.data?.publish_id),
    publishId: data.data?.publish_id || "",
    mode: "direct",
    source,
    privacyLevel,
    creatorUsername: creator.creator_username || "",
    type: "tiktok_direct_post"
  };
}

async function publishInbox({ videoUrl, videoPath, source = "PULL_FROM_URL" }) {
  await ensureTikTokAccessToken();
  const stat = source === "FILE_UPLOAD" ? await fsp.stat(videoPath) : null;
  const data = await postJson("/v2/post/publish/inbox/video/init/", {
    source_info: source === "FILE_UPLOAD"
      ? fileUploadSourceInfo(stat)
      : {
        source: "PULL_FROM_URL",
        video_url: videoUrl
      }
  });

  if (source === "FILE_UPLOAD") {
    const uploadUrl = data.data?.upload_url || "";
    if (!uploadUrl) throw new Error("TikTok tidak mengembalikan upload_url untuk file upload.");
    await uploadVideoFile(uploadUrl, videoPath, stat);
  }

  return {
    ok: Boolean(data.data?.publish_id),
    publishId: data.data?.publish_id || "",
    mode: "inbox",
    source,
    type: "tiktok_inbox_upload"
  };
}

export async function publishToTikTok({ videoUrl, videoPath, caption }) {
  if (!videoUrl && !videoPath) throw new Error("TikTok publish butuh public video URL atau path file video lokal.");
  assertTikTokPublishConfig();

  if (config.tiktok.publishMode === "inbox") {
    if (!videoUrl) return publishInbox({ videoPath, source: "FILE_UPLOAD" });
    try {
      return await publishInbox({ videoUrl });
    } catch (error) {
      if (!videoPath || !isUrlOwnershipError(error)) throw error;
      console.warn(`TikTok inbox URL upload ditolak, coba file upload: ${error.message}`);
      return publishInbox({ videoUrl, videoPath, source: "FILE_UPLOAD" });
    }
  }

  if (!videoUrl) return publishDirect({ videoPath, caption, source: "FILE_UPLOAD" });

  try {
    return await publishDirect({ videoUrl, videoPath, caption });
  } catch (error) {
    if (videoPath && isUrlOwnershipError(error)) {
      console.warn(`TikTok direct URL upload ditolak, coba file upload: ${error.message}`);
      return publishDirect({ videoUrl, videoPath, caption, source: "FILE_UPLOAD" });
    }
    if (isUnauditedDirectPostError(error)) {
      console.warn(`TikTok direct post dibatasi audit app, fallback ke inbox upload: ${error.message}`);
      return publishInbox({ videoUrl, videoPath });
    }
    if (config.tiktok.publishMode === "direct") throw error;
    console.warn(`TikTok direct post gagal, coba inbox upload: ${error.message}`);
    return publishInbox({ videoUrl, videoPath });
  }
}

async function publishPhotosDirect({ imageUrls, title, description }) {
  const creator = await queryTikTokCreatorInfo();
  const privacyLevel = pickPrivacyLevel(creator.privacy_level_options || []);
  const data = await postJson("/v2/post/publish/content/init/", {
    post_info: {
      title: normalizePhotoTitle(title),
      description: normalizeCaption(description),
      privacy_level: privacyLevel,
      disable_comment: Boolean(config.tiktok.disableComment || creator.comment_disabled),
      auto_add_music: true,
      brand_content_toggle: false,
      brand_organic_toggle: false
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: imageUrls
    },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO"
  });

  return {
    ok: Boolean(data.data?.publish_id),
    publishId: data.data?.publish_id || "",
    mode: "direct",
    source: "PULL_FROM_URL",
    privacyLevel,
    creatorUsername: creator.creator_username || "",
    type: "tiktok_photo_direct_post"
  };
}

async function publishPhotosInbox({ imageUrls, title, description }) {
  await ensureTikTokAccessToken();
  const data = await postJson("/v2/post/publish/content/init/", {
    post_info: {
      title: normalizePhotoTitle(title),
      description: normalizeCaption(description)
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: imageUrls
    },
    post_mode: "MEDIA_UPLOAD",
    media_type: "PHOTO"
  });

  return {
    ok: Boolean(data.data?.publish_id),
    publishId: data.data?.publish_id || "",
    mode: "inbox",
    source: "PULL_FROM_URL",
    type: "tiktok_photo_inbox_upload"
  };
}

async function publishCarouselAsSlideshowVideo({ imagePaths, title, description }) {
  const slideshowPath = path.join(os.tmpdir(), `tiktok-slideshow-${Date.now()}.mp4`);
  try {
    await createSlideshowVideo(imagePaths, slideshowPath);
    const result = await publishToTikTok({
      videoPath: slideshowPath,
      caption: description || title
    });
    return {
      ...result,
      type: "tiktok_carousel_slideshow_video",
      warnings: ["Carousel dikonversi menjadi slideshow video karena domain belum terverifikasi di TikTok."]
    };
  } finally {
    await fsp.unlink(slideshowPath).catch(() => {});
  }
}

async function createSlideshowVideo(imagePaths, outputPath) {
  const tmpFile = path.join(os.tmpdir(), `banyaktau-slideshow-${Date.now()}.txt`);
  let content = "";
  for (const imgPath of imagePaths) {
    const escapedPath = imgPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
    content += `file '${escapedPath}'\nduration 3.5\n`;
  }
  if (imagePaths.length > 0) {
    const escapedPath = imagePaths[imagePaths.length - 1].replace(/\\/g, "/").replace(/'/g, "'\\''");
    content += `file '${escapedPath}'\n`;
  }

  await fsp.writeFile(tmpFile, content, "utf8");

  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", tmpFile,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(1080-iw)/2:(1920-ih)/2:black",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-r", "25",
    outputPath
  ];

  const proc = spawnSync("ffmpeg", args, { encoding: "utf8" });
  await fsp.unlink(tmpFile).catch(() => {});
  if (proc.status !== 0) {
    throw new Error(`FFmpeg slideshow render gagal: ${proc.stderr || proc.stdout}`);
  }
}

export async function publishCarouselToTikTok({ imageUrls, imagePaths, title, description }) {
  const hasLocalPaths = Array.isArray(imagePaths) && imagePaths.length >= 2;
  const hasUrls = Array.isArray(imageUrls) && imageUrls.length >= 2;

  if (!hasUrls) {
    if (hasLocalPaths) {
      console.warn("URL publik carousel belum siap, mencoba fallback slideshow video...");
      return publishCarouselAsSlideshowVideo({ imagePaths, title, description });
    }
    throw new Error("TikTok photo carousel butuh minimal 2 public image URLs atau file lokal.");
  }

  assertTikTokPublishConfig();
  const urls = imageUrls.slice(0, 35);

  if (config.tiktok.publishMode === "inbox") {
    try {
      return await publishPhotosInbox({ imageUrls: urls, title, description });
    } catch (error) {
      if (isUrlOwnershipError(error) && hasLocalPaths) {
        console.warn(`TikTok inbox URL photo upload ditolak (${error.message}), coba fallback slideshow video...`);
        return publishCarouselAsSlideshowVideo({ imagePaths, title, description });
      }
      throw error;
    }
  }

  try {
    return await publishPhotosDirect({ imageUrls: urls, title, description });
  } catch (error) {
    if (isUrlOwnershipError(error) && hasLocalPaths) {
      console.warn(`TikTok direct URL photo upload ditolak (${error.message}), coba fallback slideshow video...`);
      return publishCarouselAsSlideshowVideo({ imagePaths, title, description });
    }
    if (isUnauditedDirectPostError(error)) {
      console.warn(`TikTok photo direct post dibatasi audit app, fallback ke inbox upload: ${error.message}`);
      try {
        return await publishPhotosInbox({ imageUrls: urls, title, description });
      } catch (inboxError) {
        if (isUrlOwnershipError(inboxError) && hasLocalPaths) {
          console.warn(`TikTok inbox URL photo upload ditolak (${inboxError.message}), coba fallback slideshow video...`);
          return publishCarouselAsSlideshowVideo({ imagePaths, title, description });
        }
        throw inboxError;
      }
    }
    throw error;
  }
}
