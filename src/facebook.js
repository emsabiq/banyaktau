import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function clean(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function graphUrl(apiPath) {
  return `https://graph.facebook.com/${config.facebook.graphApiVersion}/${apiPath}`;
}

function graphVideoUrl(apiPath) {
  return `https://graph-video.facebook.com/${config.facebook.graphApiVersion}/${apiPath}`;
}

function normalizeTitle(value) {
  return [config.facebook.titlePrefix, value]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "BanyakTau";
}

function normalizeDescription(value) {
  return String(value || "").slice(0, 4900);
}

function assertFacebookConfig() {
  const missing = [];
  if (!config.facebook.enabled) missing.push("FACEBOOK_UPLOAD_ENABLED=true");
  if (!config.facebook.pageId) missing.push("BANYAKTAU_FACEBOOK_PAGE_ID atau FACEBOOK_PAGE_ID");
  if (!config.facebook.accessToken && !config.facebook.userAccessToken) {
    missing.push("BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN / FACEBOOK_PAGE_ACCESS_TOKEN atau long-lived USER token");
  }
  if (missing.length) throw new Error(`Config Facebook belum lengkap: ${missing.join(", ")}`);
}

function assertInstagramVideo({ videoUrl, durationSec }) {
  const missing = [];
  if (!config.instagram.enabled) missing.push("INSTAGRAM_UPLOAD_ENABLED=true");
  if (!videoUrl) missing.push("public video URL");
  if (missing.length) throw new Error(`Config Instagram belum lengkap: ${missing.join(", ")}`);

  const duration = Number(durationSec || 0);
  if (duration && duration > config.instagram.maxDurationSec) {
    throw new Error(
      `Durasi video ${duration.toFixed(1)} detik melebihi batas Instagram Reels ` +
      `${config.instagram.maxDurationSec} detik. Turunkan durasi video atau ubah INSTAGRAM_MAX_DURATION_SECONDS jika akun mendukung.`
    );
  }
}

function assertInstagramCarousel({ imageUrls }) {
  const missing = [];
  if (!config.instagram.enabled) missing.push("INSTAGRAM_UPLOAD_ENABLED=true");
  if (!Array.isArray(imageUrls) || imageUrls.length < 2) missing.push("minimal 2 public carousel image URLs");
  if (missing.length) throw new Error(`Config Instagram carousel belum lengkap: ${missing.join(", ")}`);
}

function assertFacebookCarousel({ imageUrls, imagePaths }) {
  const missing = [];
  if (!config.facebook.enabled) missing.push("FACEBOOK_UPLOAD_ENABLED=true");
  const urlCount = Array.isArray(imageUrls) ? imageUrls.length : 0;
  const pathCount = Array.isArray(imagePaths) ? imagePaths.length : 0;
  if (Math.max(urlCount, pathCount) < 2) missing.push("minimal 2 carousel images");
  if (missing.length) throw new Error(`Config Facebook carousel belum lengkap: ${missing.join(", ")}`);
  assertFacebookConfig();
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
    const apiError = data?.error || {};
    const detail = apiError.message || data.raw || text || response.statusText;
    const error = new Error(`${detail} [code ${apiError.code || response.status}]`);
    error.apiCode = apiError.code;
    error.apiSubcode = apiError.error_subcode;
    throw error;
  }
  return data;
}

async function tokenIdentity(token) {
  const url = new URL(graphUrl("me"));
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", token);
  return fetchJson(url);
}

async function derivePageAccessToken(userToken) {
  const url = new URL(graphUrl("me/accounts"));
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", userToken);
  const data = await fetchJson(url);
  const page = (data.data || []).find((entry) => String(entry.id) === String(config.facebook.pageId));
  if (!page?.access_token) throw new Error("User token Facebook tidak punya akses ke Page target.");
  return page.access_token;
}

async function resolvePageAccessToken() {
  const directToken = clean(config.facebook.accessToken);
  const userToken = clean(config.facebook.userAccessToken);

  if (directToken) {
    try {
      const identity = await tokenIdentity(directToken);
      if (String(identity.id) === String(config.facebook.pageId)) return directToken;
      return derivePageAccessToken(directToken);
    } catch (error) {
      if (!userToken) throw error;
    }
  }

  if (userToken) return derivePageAccessToken(userToken);
  throw new Error("Token Facebook belum diisi.");
}

async function resolveOptionalPageAccessToken() {
  if (!config.facebook.pageId || (!config.facebook.accessToken && !config.facebook.userAccessToken)) return "";
  try {
    return await resolvePageAccessToken();
  } catch {
    return "";
  }
}

function resolveInstagramAccessToken(pageToken = "") {
  return clean(config.instagram.accessToken || config.facebook.userAccessToken || pageToken || config.facebook.accessToken);
}

async function resolveInstagramUserId(token) {
  if (config.instagram.igUserId) return config.instagram.igUserId;
  if (!config.facebook.pageId) {
    throw new Error("INSTAGRAM_IG_USER_ID belum diisi dan FACEBOOK_PAGE_ID tidak tersedia untuk auto-resolve.");
  }

  const url = new URL(graphUrl(config.facebook.pageId));
  url.searchParams.set("fields", "instagram_business_account{id,username}");
  url.searchParams.set("access_token", token);
  const data = await fetchJson(url);
  const igUserId = clean(data.instagram_business_account?.id);
  if (!igUserId) {
    throw new Error("Facebook Page belum terhubung ke Instagram Business/Creator account, atau token belum punya akses.");
  }
  return igUserId;
}

async function publishFacebookPageVideo({ token, videoUrl, title, description }) {
  const body = new URLSearchParams({
    access_token: token,
    file_url: videoUrl,
    title: normalizeTitle(title),
    description: normalizeDescription(description),
    published: String(config.facebook.videoState).toUpperCase() === "PUBLISHED" ? "true" : "false"
  });

  const data = await fetchJson(graphVideoUrl(`${config.facebook.pageId}/videos`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const videoId = clean(data.id);
  return {
    ok: Boolean(videoId),
    type: "facebook_video",
    videoId,
    url: videoId ? `https://www.facebook.com/${videoId}` : ""
  };
}

async function startFacebookReel(token) {
  const url = new URL(graphUrl(`${config.facebook.pageId}/video_reels`));
  url.searchParams.set("access_token", token);
  url.searchParams.set("upload_phase", "start");
  const data = await fetchJson(url, { method: "POST" });
  const videoId = clean(data.video_id);
  const uploadUrl = clean(data.upload_url);
  if (!videoId || !uploadUrl) {
    throw new Error(`Facebook tidak mengembalikan video_id/upload_url: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { videoId, uploadUrl };
}

async function uploadFacebookReelFromUrl({ token, uploadUrl, videoUrl }) {
  await fetchJson(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      file_url: videoUrl
    }
  });
}

async function finishFacebookReel({ token, videoId, title, description }) {
  const url = new URL(graphUrl(`${config.facebook.pageId}/video_reels`));
  url.searchParams.set("access_token", token);
  url.searchParams.set("upload_phase", "finish");
  url.searchParams.set("video_id", videoId);
  url.searchParams.set("video_state", config.facebook.videoState || "PUBLISHED");
  url.searchParams.set("title", normalizeTitle(title));
  url.searchParams.set("description", normalizeDescription(description));
  const data = await fetchJson(url, { method: "POST" });
  return {
    ok: true,
    type: "facebook_reel",
    videoId,
    postId: clean(data.post_id),
    url: `https://www.facebook.com/reel/${videoId}`
  };
}

async function publishFacebookReel({ token, videoUrl, title, description }) {
  const started = await startFacebookReel(token);
  await uploadFacebookReelFromUrl({ token, uploadUrl: started.uploadUrl, videoUrl });
  return finishFacebookReel({
    token,
    videoId: started.videoId,
    title,
    description
  });
}

async function createInstagramReelContainer({ token, igUserId, videoUrl, caption, coverUrl }) {
  const body = new URLSearchParams({
    access_token: token,
    media_type: "REELS",
    video_url: videoUrl,
    caption: normalizeDescription(caption),
    share_to_feed: config.instagram.shareToFeed ? "true" : "false"
  });
  if (coverUrl) body.set("cover_url", coverUrl);

  const data = await fetchJson(graphUrl(`${igUserId}/media`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const containerId = clean(data.id);
  if (!containerId) throw new Error(`Instagram tidak mengembalikan container id: ${JSON.stringify(data).slice(0, 500)}`);
  return containerId;
}

async function createInstagramCarouselImageContainer({ token, igUserId, imageUrl }) {
  const body = new URLSearchParams({
    access_token: token,
    image_url: imageUrl,
    is_carousel_item: "true"
  });
  const data = await fetchJson(graphUrl(`${igUserId}/media`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const containerId = clean(data.id);
  if (!containerId) throw new Error(`Instagram tidak mengembalikan child carousel id: ${JSON.stringify(data).slice(0, 500)}`);
  return containerId;
}

async function createInstagramCarouselContainer({ token, igUserId, childIds, caption }) {
  const body = new URLSearchParams({
    access_token: token,
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: normalizeDescription(caption)
  });
  const data = await fetchJson(graphUrl(`${igUserId}/media`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const containerId = clean(data.id);
  if (!containerId) throw new Error(`Instagram tidak mengembalikan parent carousel id: ${JSON.stringify(data).slice(0, 500)}`);
  return containerId;
}

async function getInstagramContainerStatus({ token, containerId }) {
  const url = new URL(graphUrl(containerId));
  url.searchParams.set("fields", "id,status_code,status");
  url.searchParams.set("access_token", token);
  return fetchJson(url);
}

async function waitForInstagramContainer({ token, containerId }) {
  const maxAttempts = config.instagram.containerMaxAttempts;
  const delayMs = config.instagram.containerPollSeconds * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await getInstagramContainerStatus({ token, containerId });
    const code = clean(status.status_code);
    if (code === "FINISHED") return status;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Instagram container gagal diproses: ${containerId}, status=${code || status.status || "unknown"}`);
    }
    await sleep(delayMs);
  }

  const waitedMinutes = Math.round((maxAttempts * delayMs) / 60000);
  throw new Error(`Instagram container belum siap setelah ${waitedMinutes} menit: ${containerId}`);
}

async function publishInstagramContainer({ token, igUserId, containerId }) {
  const body = new URLSearchParams({
    access_token: token,
    creation_id: containerId
  });
  const data = await fetchJson(graphUrl(`${igUserId}/media_publish`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const mediaId = clean(data.id);
  if (!mediaId) throw new Error(`Instagram tidak mengembalikan media id: ${JSON.stringify(data).slice(0, 500)}`);
  return mediaId;
}

async function resolveInstagramPermalink({ token, mediaId }) {
  try {
    const url = new URL(graphUrl(mediaId));
    url.searchParams.set("fields", "permalink");
    url.searchParams.set("access_token", token);
    const data = await fetchJson(url);
    return clean(data.permalink);
  } catch {
    return "";
  }
}

export async function publishToInstagram({ videoUrl, title, description, coverUrl, durationSec }) {
  assertInstagramVideo({ videoUrl, durationSec });
  const pageToken = await resolveOptionalPageAccessToken();
  const token = resolveInstagramAccessToken(pageToken);
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN belum diisi.");

  const igUserId = await resolveInstagramUserId(token);
  const caption = normalizeDescription(description || title);
  const containerId = await createInstagramReelContainer({ token, igUserId, videoUrl, caption, coverUrl });
  await waitForInstagramContainer({ token, containerId });
  const mediaId = await publishInstagramContainer({ token, igUserId, containerId });
  const url = await resolveInstagramPermalink({ token, mediaId });
  return {
    ok: Boolean(mediaId),
    type: "instagram_reel",
    mediaId,
    containerId,
    igUserId,
    url
  };
}

export async function publishCarouselToInstagram({ imageUrls, title, description }) {
  assertInstagramCarousel({ imageUrls });
  const pageToken = await resolveOptionalPageAccessToken();
  const token = resolveInstagramAccessToken(pageToken);
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN belum diisi.");

  const igUserId = await resolveInstagramUserId(token);
  const caption = normalizeDescription(description || title);
  const urls = imageUrls.slice(0, 10);
  const childIds = [];
  for (const imageUrl of urls) {
    const childId = await createInstagramCarouselImageContainer({ token, igUserId, imageUrl });
    await waitForInstagramContainer({ token, containerId: childId });
    childIds.push(childId);
  }
  const containerId = await createInstagramCarouselContainer({ token, igUserId, childIds, caption });
  await waitForInstagramContainer({ token, containerId });
  const mediaId = await publishInstagramContainer({ token, igUserId, containerId });
  const url = await resolveInstagramPermalink({ token, mediaId });
  return {
    ok: Boolean(mediaId),
    type: "instagram_carousel",
    mediaId,
    containerId,
    childIds,
    igUserId,
    url
  };
}

export async function publishToFacebook({ videoUrl, title, description }) {
  assertFacebookConfig();
  if (!videoUrl) throw new Error("Facebook butuh public video URL.");

  const token = await resolvePageAccessToken();
  if (config.facebook.mediaType === "video") {
    return publishFacebookPageVideo({ token, videoUrl, title, description });
  }

  try {
    return await publishFacebookReel({ token, videoUrl, title, description });
  } catch (error) {
    if (!config.facebook.reelFallbackEnabled) throw error;
    console.warn(`Facebook Reel gagal, coba fallback Page video: ${error.message}`);
    const fallback = await publishFacebookPageVideo({ token, videoUrl, title, description });
    return { ...fallback, fallbackFrom: "facebook_reel" };
  }
}

async function createFacebookUnpublishedPhoto({ token, imageUrl, imagePath, caption }) {
  let data;
  if (imagePath) {
    const buffer = await fs.readFile(imagePath);
    const form = new FormData();
    form.set("access_token", token);
    form.set("caption", normalizeDescription(caption));
    form.set("published", "false");
    form.set("source", new Blob([buffer], { type: "image/jpeg" }), path.basename(imagePath));
    data = await fetchJson(graphUrl(`${config.facebook.pageId}/photos`), {
      method: "POST",
      body: form
    });
  } else {
    const body = new URLSearchParams({
      access_token: token,
      url: imageUrl,
      caption: normalizeDescription(caption),
      published: "false"
    });
    data = await fetchJson(graphUrl(`${config.facebook.pageId}/photos`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  }
  const photoId = clean(data.id);
  if (!photoId) throw new Error(`Facebook tidak mengembalikan photo id: ${JSON.stringify(data).slice(0, 500)}`);
  return photoId;
}

export async function publishCarouselToFacebook({ imageUrls = [], imagePaths = [], title, description }) {
  assertFacebookCarousel({ imageUrls, imagePaths });
  const token = await resolvePageAccessToken();
  const caption = normalizeDescription(description || title);
  const urls = imageUrls.slice(0, 10);
  const paths = imagePaths.slice(0, 10);
  const count = Math.max(urls.length, paths.length);
  const photoIds = [];
  for (let index = 0; index < count; index += 1) {
    photoIds.push(await createFacebookUnpublishedPhoto({
      token,
      imageUrl: urls[index],
      imagePath: paths[index],
      caption: title
    }));
  }

  const body = new URLSearchParams({
    access_token: token,
    message: caption
  });
  photoIds.forEach((photoId, index) => {
    body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: photoId }));
  });

  const data = await fetchJson(graphUrl(`${config.facebook.pageId}/feed`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const postId = clean(data.id);
  return {
    ok: Boolean(postId),
    type: "facebook_photo_carousel",
    postId,
    photoIds,
    url: postId ? `https://www.facebook.com/${postId}` : ""
  };
}

export async function publishToSocials(options) {
  const result = { ok: false, errors: {} };

  if (config.facebook.enabled) {
    try {
      result.facebook = await publishToFacebook(options);
    } catch (error) {
      result.errors.facebook = error.message;
    }
  }

  if (config.instagram.enabled) {
    try {
      result.instagram = await publishToInstagram(options);
    } catch (error) {
      result.errors.instagram = error.message;
    }
  }

  result.ok = Boolean(result.facebook?.ok || result.instagram?.ok);
  if (!result.ok && Object.keys(result.errors).length) {
    throw new Error(Object.entries(result.errors).map(([platform, message]) => `${platform}: ${message}`).join("; "));
  }

  return result;
}
