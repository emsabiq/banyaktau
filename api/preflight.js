import { clean, methodAllowed, readRemoteItems, requireAuth, sendJson } from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;

  const checks = [];
  checks.push(check("GH_REPO_SECRET_TOKEN", Boolean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN), "Token GitHub untuk dispatch workflow."));
  checks.push(check("DASHBOARD_GITHUB_REPO", Boolean(process.env.DASHBOARD_GITHUB_REPO || process.env.GITHUB_REPOSITORY), "Repo target workflow."));
  checks.push(check("PUBLIC_BASE_URL", Boolean(process.env.PUBLIC_BASE_URL), "Base URL state dan asset."));
  checks.push(check(
    "WORKFLOW_SECRETS",
    true,
    "Secret OpenAI/upload dicek di GitHub Actions saat workflow berjalan. Gemini dan clip video tidak dipakai.",
    false
  ));
  if (String(process.env.FACEBOOK_UPLOAD_ENABLED || "").toLowerCase() === "true") {
    checks.push(check("FACEBOOK_PAGE_ID", Boolean(process.env.BANYAKTAU_FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID), "Page Facebook BanyakTau untuk auto upload."));
    checks.push(check("FACEBOOK_TOKEN", Boolean(
      process.env.BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN
      || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
      || process.env.BANYAKTAU_FACEBOOK_USER_ACCESS_TOKEN
      || process.env.FACEBOOK_USER_ACCESS_TOKEN
    ), "Page token atau user token Facebook."));
  }
  if (String(process.env.INSTAGRAM_UPLOAD_ENABLED || process.env.BANYAKTAU_INSTAGRAM_UPLOAD_ENABLED || "").toLowerCase() === "true") {
    checks.push(check("INSTAGRAM_TARGET", Boolean(
      process.env.BANYAKTAU_INSTAGRAM_IG_USER_ID
      || process.env.INSTAGRAM_IG_USER_ID
      || process.env.BANYAKTAU_FACEBOOK_PAGE_ID
      || process.env.FACEBOOK_PAGE_ID
    ), "IG User ID atau Facebook Page yang terhubung ke Instagram."));
    checks.push(check("INSTAGRAM_TOKEN", Boolean(
      process.env.BANYAKTAU_INSTAGRAM_ACCESS_TOKEN
      || process.env.INSTAGRAM_ACCESS_TOKEN
      || process.env.BANYAKTAU_FACEBOOK_USER_ACCESS_TOKEN
      || process.env.FACEBOOK_USER_ACCESS_TOKEN
      || process.env.BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN
      || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    ), "Token Instagram atau token Meta/Facebook dengan izin publish Instagram."));
  }
  if (String(process.env.YOUTUBE_UPLOAD_ENABLED || "").toLowerCase() === "true") {
    checks.push(check("YOUTUBE_CLIENT_ID", Boolean(process.env.YOUTUBE_CLIENT_ID), "OAuth Client ID untuk upload YouTube."));
    checks.push(check("YOUTUBE_CLIENT_SECRET", Boolean(process.env.YOUTUBE_CLIENT_SECRET), "OAuth Client Secret untuk upload YouTube."));
    checks.push(check("YOUTUBE_REFRESH_TOKEN", Boolean(process.env.YOUTUBE_REFRESH_TOKEN), "Refresh token YouTube untuk auto upload."));
  }

  const driver = clean(process.env.UPLOAD_DRIVER || "auto");
  const hasSftp = Boolean(process.env.SFTP_HOST && process.env.SFTP_USER && process.env.SFTP_PASSWORD && process.env.SFTP_REMOTE_DIR);
  const hasFtp = Boolean(process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD && process.env.FTP_REMOTE_DIR);
  checks.push(check(
    "UPLOAD_REMOTE",
    driver === "auto" ? hasSftp || hasFtp : driver === "sftp" ? hasSftp : hasFtp,
    `Driver: ${driver}. Jika kosong di Vercel, workflow tetap memakai GitHub Secrets.`,
    false
  ));

  const items = await readRemoteItems();
  checks.push(check("STATE_ITEMS", Array.isArray(items), `${items.length || 0} item terbaca.`));
  const latest = items.find((item) => item.assets?.video?.url || item.assets?.images?.length);
  if (latest?.assets?.video?.url) checks.push(await checkUrl("LATEST_VIDEO", latest.assets.video.url, false));
  if (latest?.assets?.thumbnail?.url) checks.push(await checkUrl("LATEST_THUMBNAIL", latest.assets.thumbnail.url, false));

  const failedRequired = checks.filter((entry) => !entry.ok && entry.required !== false);
  const warnings = checks.filter((entry) => !entry.ok && entry.required === false);
  sendJson(res, failedRequired.length ? 409 : 200, {
    ok: failedRequired.length === 0,
    summary: failedRequired.length
      ? `${failedRequired.length} preflight check gagal.`
      : warnings.length ? `Preflight aman, ${warnings.length} warning preview.` : "Preflight aman.",
    checks
  });
}

function check(name, ok, detail, required = true) {
  return { name, ok: Boolean(ok), detail, required };
}

async function checkUrl(name, url, required = true) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return check(name, response.ok, `${response.status} ${url}`, required);
  } catch (error) {
    return check(name, false, error.message, required);
  }
}
