export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendJson(res, 405, { error: `Method ${req.method} tidak didukung.` });
  return false;
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function requireAuth(req, res) {
  const expected = clean(process.env.AUTO_DASHBOARD_PIN || "123456");
  if (!expected) return true;
  const provided = clean(req.headers["x-dashboard-pin"] || queryValue(req, "pin") || cookieValue(req.headers.cookie || "", "banyaktau_pin"));
  if (provided === expected) return true;
  sendJson(res, 401, { error: "PIN dashboard tidak valid." });
  return false;
}

export async function readRemoteItems() {
  const base = cleanBaseUrl(process.env.PUBLIC_BASE_URL);
  if (!base) return [];
  try {
    const response = await fetch(`${base}/state/items.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function normalizeRemoteItemUrls(items) {
  const publicBase = cleanBaseUrl(process.env.PUBLIC_BASE_URL);
  const fix = (asset) => {
    if (!asset?.url) return asset;
    let url = String(asset.url);
    url = url.replace("https://banyaktau.emsa.pro/generated/", `${publicBase}/`);
    url = url.replace(`${publicBase}/generated/`, `${publicBase}/`);
    return { ...asset, url };
  };
  return (items || []).map((item) => ({
    ...item,
    assets: {
      ...item.assets,
      video: fix(item.assets?.video),
      audio: fix(item.assets?.audio),
      thumbnail: fix(item.assets?.thumbnail),
      images: (item.assets?.images || []).map(fix),
      clips: (item.assets?.clips || []).map(fix)
    }
  }));
}

export async function dispatchWorkflow(inputs) {
  const token = githubToken();
  if (!token) throw new Error("GH_REPO_SECRET_TOKEN belum diset di Vercel Environment.");
  const repo = githubRepo();
  if (!repo) throw new Error("DASHBOARD_GITHUB_REPO belum diset di Vercel Environment.");
  const workflow = clean(process.env.DASHBOARD_WORKFLOW_FILE || "banyaktau-generate.yml");
  const ref = clean(process.env.DASHBOARD_GITHUB_REF || "main");
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ ref, inputs })
  });
  if (response.status === 204) return { ok: true, repo, workflow, ref };
  const detail = await response.text();
  throw new Error(`Gagal trigger workflow (${response.status}): ${detail.slice(0, 500)}`);
}

export async function getRecentWorkflowRuns(limit = 5) {
  const token = githubToken();
  if (!token) return [];
  const repo = githubRepo();
  if (!repo) return [];
  const workflow = clean(process.env.DASHBOARD_WORKFLOW_FILE || "banyaktau-generate.yml");
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${limit}`, {
    headers: githubHeaders(token),
    cache: "no-store"
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.workflow_runs || []).map(mapWorkflowRun);
}

export async function getRunJobs(runId) {
  const token = githubToken();
  if (!token || !runId) return [];
  const repo = githubRepo();
  if (!repo) return [];
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=40`, {
    headers: githubHeaders(token),
    cache: "no-store"
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.jobs || []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    steps: (job.steps || []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      started_at: step.started_at,
      completed_at: step.completed_at
    }))
  }));
}

export function publicConfig() {
  const tiktokPaused = boolEnv("TIKTOK_UPLOAD_PAUSED");
  const tiktokEnabled = !tiktokPaused && boolEnv("TIKTOK_UPLOAD_ENABLED", "BANYAKTAU_TIKTOK_UPLOAD_ENABLED");
  return {
    port: 0,
    publicBaseUrl: cleanBaseUrl(process.env.PUBLIC_BASE_URL),
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      openaiBaseUrl: cleanBaseUrl(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      storyModel: clean(process.env.STORY_MODEL || "gpt-4.1-mini"),
      imageModel: clean(process.env.IMAGE_MODEL || "gpt-image-1-mini"),
      imageSize: clean(process.env.IMAGE_SIZE || "1024x1536"),
      imageQuality: clean(process.env.IMAGE_QUALITY || "low"),
      videoProvider: "disabled",
      videoBaseUrl: "",
      videoEndpointMode: "disabled",
      videoModel: "",
      videoAspectRatio: "9:16",
      videoResolution: "720p",
      videoSeconds: 0,
      videoApiKeySet: false,
      facebookUploadEnabled: String(process.env.FACEBOOK_UPLOAD_ENABLED || "").toLowerCase() === "true",
      facebookPageIdSet: Boolean(process.env.BANYAKTAU_FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID),
      facebookPageTokenSet: Boolean(
        process.env.BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN
        || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
        || process.env.BANYAKTAU_FACEBOOK_USER_ACCESS_TOKEN
        || process.env.FACEBOOK_USER_ACCESS_TOKEN
      ),
      instagramUploadEnabled: String(process.env.INSTAGRAM_UPLOAD_ENABLED || process.env.BANYAKTAU_INSTAGRAM_UPLOAD_ENABLED || "").toLowerCase() === "true",
      instagramIgUserIdSet: Boolean(process.env.BANYAKTAU_INSTAGRAM_IG_USER_ID || process.env.INSTAGRAM_IG_USER_ID),
      instagramAccessTokenSet: Boolean(process.env.BANYAKTAU_INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN),
      youtubeUploadEnabled: String(process.env.YOUTUBE_UPLOAD_ENABLED || "").toLowerCase() === "true",
      youtubeClientIdSet: Boolean(process.env.YOUTUBE_CLIENT_ID),
      youtubeRefreshTokenSet: Boolean(process.env.YOUTUBE_REFRESH_TOKEN),
      tiktokUploadEnabled: tiktokEnabled,
      tiktokUploadPaused: tiktokPaused,
      tiktokClientKeySet: Boolean(process.env.TIKTOK_CLIENT_KEY),
      tiktokTokenSet: Boolean(process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_REFRESH_TOKEN),
      tiktokPublishMode: clean(process.env.TIKTOK_PUBLISH_MODE || "direct").toLowerCase(),
      tiktokPrivacyLevel: clean(process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY"),
      geminiApiKeySet: false,
      geminiBaseUrl: "",
      openaiApiKeySet: Boolean(process.env.OPENAI_API_KEY),
      openaiTtsModel: clean(process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"),
      openaiTtsVoice: clean(process.env.OPENAI_TTS_VOICE || "shimmer"),
      openaiTranscribeModel: clean(process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1"),
      elevenlabsApiKeySet: Boolean(process.env.ELEVENLABS_API_KEY),
      elevenlabsModel: clean(process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2"),
      elevenlabsVoiceId: clean(process.env.ELEVENLABS_VOICE_ID || "")
    },
    render: {
      speechTempo: Number(process.env.SPEECH_TEMPO || 1.15)
    },
    pricing: {
      videoUsdPerSecond: 0
    },
    dashboard: {
      vercel: true,
      productionMode: "images-tts-only",
      pinRequired: true
    }
  };
}

export function clean(value) {
  return String(value || "").trim();
}

function cleanBaseUrl(value) {
  return clean(value).replace(/\/+$/g, "");
}

function boolEnv(...names) {
  return names.some((name) => ["1", "true", "yes", "on"].includes(clean(process.env[name]).toLowerCase()));
}

function queryValue(req, name) {
  try {
    return new URL(req.url, "https://banyaktau.local").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function mapWorkflowRun(run) {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    run_attempt: run.run_attempt,
    display_title: run.display_title || run.head_commit?.message || "",
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url
  };
}

function githubRepo() {
  return clean(process.env.DASHBOARD_GITHUB_REPO || process.env.GITHUB_REPOSITORY);
}

function githubToken() {
  return clean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "banyaktau-dashboard"
  };
}

function cookieValue(raw, name) {
  for (const part of String(raw || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
