import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, paths } from "./config.js";
import { remoteConfig, remoteEnabled } from "./remote.js";

export async function runPreflight() {
  const checks = [];
  checks.push(checkCommand("ffmpeg"));
  checks.push(checkCommand("ffprobe"));
  checks.push(checkValue("OPENAI_API_KEY", Boolean(config.openai.apiKey), "Story, gambar, TTS, dan transkripsi butuh key ini."));
  checks.push(checkValue("PUBLIC_BASE_URL", Boolean(config.publicBaseUrl || process.env.PUBLIC_BASE_URL), "Dashboard butuh base URL publik untuk preview asset."));

  const remote = remoteConfig();
  checks.push(checkValue("UPLOAD_DRIVER", remoteEnabled(), `Driver aktif: ${remote.driver}`));
  if (remoteEnabled()) {
    checks.push(checkValue(`${remote.prefix}_HOST`, Boolean(remote.host), "Host upload remote wajib ada."));
    checks.push(checkValue(`${remote.prefix}_USER`, Boolean(remote.user), "User upload remote wajib ada."));
    checks.push(checkValue(`${remote.prefix}_PASSWORD`, Boolean(remote.password), "Password upload remote wajib ada."));
    checks.push(checkValue(`${remote.prefix}_REMOTE_DIR`, Boolean(remote.remoteDir), "Folder remote wajib ada."));
  }

  if (config.facebook.enabled) {
    checks.push(checkValue("FACEBOOK_PAGE_ID", Boolean(config.facebook.pageId), "Page Facebook BanyakTau wajib diisi untuk auto upload."));
    checks.push(checkValue("FACEBOOK_TOKEN", Boolean(config.facebook.accessToken || config.facebook.userAccessToken), "Page token atau user token Facebook wajib diisi."));
  }

  if (config.instagram.enabled) {
    checks.push(checkValue(
      "INSTAGRAM_TARGET",
      Boolean(config.instagram.igUserId || config.facebook.pageId),
      "Isi INSTAGRAM_IG_USER_ID, atau hubungkan Instagram Business ke Facebook Page target."
    ));
    checks.push(checkValue(
      "INSTAGRAM_TOKEN",
      Boolean(config.instagram.accessToken || config.facebook.userAccessToken || config.facebook.accessToken),
      "Access token Instagram atau token Meta/Facebook yang punya izin instagram_content_publish."
    ));
  }

  if (config.youtube.enabled) {
    checks.push(checkValue("YOUTUBE_CLIENT_ID", Boolean(config.youtube.clientId), "OAuth Client ID YouTube wajib diisi."));
    checks.push(checkValue("YOUTUBE_CLIENT_SECRET", Boolean(config.youtube.clientSecret), "OAuth Client Secret YouTube wajib diisi."));
    checks.push(checkValue("YOUTUBE_REFRESH_TOKEN", Boolean(config.youtube.refreshToken), "Refresh token YouTube wajib diisi."));
  }

  if (config.tiktok.paused) {
    checks.push(checkValue("TIKTOK_UPLOAD_PAUSED", true, "TikTok upload sedang dipause."));
  } else if (config.tiktok.enabled) {
    checks.push(checkValue("TIKTOK_CLIENT_KEY", Boolean(config.tiktok.clientKey), "Client key TikTok wajib diisi."));
    checks.push(checkValue("TIKTOK_CLIENT_SECRET", Boolean(config.tiktok.clientSecret), "Client secret TikTok wajib diisi."));
    checks.push(checkValue("TIKTOK_TOKEN", Boolean(config.tiktok.accessToken || config.tiktok.refreshToken), "Access token atau refresh token TikTok wajib diisi."));
  }

  checks.push(await checkFile("background_music", path.join(paths.rootDir, "assets", "music", "eksplorasi-literasi.m4a")));

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    checks,
    summary: failed.length ? `${failed.length} preflight check gagal.` : "Preflight aman."
  };
}

function checkCommand(name) {
  const result = spawnSync(name, ["-version"], { encoding: "utf8", windowsHide: true });
  return {
    name,
    ok: result.status === 0,
    detail: result.status === 0 ? firstLine(result.stdout || result.stderr) : `${name} tidak tersedia.`
  };
}

function checkValue(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

async function checkFile(name, filePath) {
  try {
    const stat = await fs.stat(filePath);
    return { name, ok: stat.isFile(), detail: `${Math.round(stat.size / 1024)} KB` };
  } catch {
    return { name, ok: false, detail: `${filePath} tidak ditemukan.` };
  }
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find(Boolean) || "OK";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runPreflight();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
