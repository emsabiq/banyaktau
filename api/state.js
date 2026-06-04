import {
  getRecentWorkflowRuns,
  getRunJobs,
  methodAllowed,
  normalizeRemoteItemUrls,
  publicConfig,
  readRemoteItems,
  requireAuth,
  sendJson
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const [itemsRaw, videoRuns, carouselRuns] = await Promise.all([
      readRemoteItems(),
      getRecentWorkflowRuns(5),
      getRecentWorkflowRuns(5, { workflow: "banyaktau-publish-carousel.yml" })
    ]);
    const recentRuns = [...videoRuns, ...carouselRuns]
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, 5);
    const items = normalizeRemoteItemUrls(itemsRaw)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const latestRun = recentRuns[0] || null;
    const liveJobs = latestRun && ["queued", "in_progress"].includes(latestRun.status)
      ? await getRunJobs(latestRun.id)
      : latestRun ? await getRunJobs(latestRun.id) : [];

    sendJson(res, 200, {
      config: publicConfig(),
      items,
      activeRun: latestRun ? buildActiveRun(latestRun, liveJobs) : null,
      recentRuns
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function buildActiveRun(run, liveJobs) {
  const allSteps = liveJobs.flatMap((job) =>
    (job.steps || []).map((step) => ({ ...step, jobName: job.name }))
  );
  const total = allSteps.length;
  const completed = allSteps.filter((step) => step.status === "completed").length;
  const inProgress = allSteps.find((step) => step.status === "in_progress") || null;
  const progress = total ? Math.round((completed / total) * 100) : run.status === "completed" ? 100 : 8;
  const status = ["queued", "in_progress"].includes(run.status) ? "running" : run.conclusion || run.status;

  const sortedSteps = [...allSteps].sort((a, b) =>
    String(a.started_at || "").localeCompare(String(b.started_at || ""))
  );
  const stepLogs = sortedSteps
    .filter((step) => step.status !== "queued" && step.started_at)
    .flatMap((step) => stepLogRows(step));
  const logs = [
    {
      at: run.created_at,
      level: "system",
      text: `${run.name || "Workflow"} ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`
    },
    ...stepLogs
  ];

  return {
    id: String(run.id),
    name: run.name || "BanyakTau Generate",
    title: run.display_title || "",
    branch: run.head_branch || "",
    status,
    conclusion: run.conclusion || "",
    startedAt: run.created_at,
    finishedAt: run.status === "completed" ? run.updated_at : "",
    htmlUrl: run.html_url,
    detail: inProgress ? `Sedang: ${inProgress.jobName} -> ${inProgress.name}` : run.display_title || "Menunggu step berikutnya.",
    progress,
    totalSteps: total,
    completedSteps: completed,
    jobs: liveJobs,
    logs,
    error: run.conclusion === "failure" ? "GitHub Actions gagal. Buka link run untuk detail." : ""
  };
}

function stepLogRows(step) {
  const rows = [{
    at: step.started_at,
    level: "running",
    text: `${step.jobName} -> ${step.name}`
  }];
  if (step.status === "completed") {
    const seconds = step.completed_at && step.started_at
      ? Math.max(0, Math.round((new Date(step.completed_at) - new Date(step.started_at)) / 1000))
      : null;
    const failed = ["failure", "cancelled"].includes(step.conclusion);
    rows.push({
      at: step.completed_at || step.started_at,
      level: failed ? "error" : "done",
      text: `${step.jobName} -> ${step.name} ${step.conclusion || "done"}${seconds !== null ? ` (${seconds}s)` : ""}`
    });
  }
  return rows;
}
