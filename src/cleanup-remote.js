import { Readable } from "node:stream";
import path from "node:path";
import { ensureProjectDirs } from "./config.js";
import { compactMemoryItem } from "./storage.js";
import { remoteConfig, remoteEnabled, withRemoteClient } from "./remote.js";

const defaultRetentionDays = 7;
const defaultSubdirs = ["videos", "thumbnails", "images", "carousels", "audio", "clips"];

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function csvValue(value, fallback) {
  const rows = String(value || "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
  return rows.length ? rows : fallback;
}

function normalizeMemoryPayload(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function readRemoteJson(client, remotePath, fallback) {
  try {
    return JSON.parse(await client.readFile(remotePath));
  } catch {
    return fallback;
  }
}

async function writeRemoteJson(client, remotePath, value) {
  await client.ensureDir(path.posix.dirname(remotePath));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await client.uploadStream(Readable.from([Buffer.from(body, "utf8")]), remotePath);
}

function mergeMemory(activeItems, existingMemory) {
  const byId = new Map();
  for (const item of normalizeMemoryPayload(existingMemory)) {
    const compact = compactMemoryItem(item);
    if (compact.id) byId.set(compact.id, { ...item, ...compact });
  }
  for (const item of activeItems || []) {
    const compact = compactMemoryItem(item);
    if (compact.id) byId.set(compact.id, { ...(byId.get(compact.id) || {}), ...compact });
  }
  return [...byId.values()]
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, 2000);
}

function itemTime(item) {
  const time = Date.parse(item?.updatedAt || item?.createdAt || "");
  return Number.isFinite(time) ? time : 0;
}

async function cleanupSubdir(client, subdir, options) {
  const stats = { scanned: 0, deleted: 0, skipped: 0, errors: 0, freedBytes: 0 };
  let files = [];
  try {
    files = await client.list(subdir);
  } catch (error) {
    console.log(`Skip ${subdir}: ${error.message}`);
    return stats;
  }

  for (const file of files) {
    if (!file.isFile) continue;
    stats.scanned += 1;
    const modifiedAt = file.modifiedAt instanceof Date ? file.modifiedAt.getTime() : 0;
    if (!options.deleteAll && (!modifiedAt || modifiedAt >= options.cutoffMs)) {
      stats.skipped += 1;
      continue;
    }

    const ageDays = modifiedAt ? ((Date.now() - modifiedAt) / 86400000).toFixed(1) : "?";
    const sizeKb = file.size ? Math.round(file.size / 1024) : 0;
    const remotePath = path.posix.join(subdir, file.name);
    console.log(`${options.dryRun ? "dry" : "delete"} ${remotePath} age=${ageDays}d size=${sizeKb}KB`);

    if (options.dryRun) {
      stats.deleted += 1;
      stats.freedBytes += file.size || 0;
      continue;
    }

    try {
      await client.remove(remotePath);
      stats.deleted += 1;
      stats.freedBytes += file.size || 0;
    } catch (error) {
      console.log(`  gagal hapus: ${error.message}`);
      stats.errors += 1;
    }
  }

  return stats;
}

function addStats(target, stats) {
  target.scanned += stats.scanned;
  target.deleted += stats.deleted;
  target.skipped += stats.skipped;
  target.errors += stats.errors;
  target.freedBytes += stats.freedBytes;
}

async function main() {
  ensureProjectDirs();
  if (!remoteEnabled()) {
    console.log("Remote upload tidak aktif; cleanup dilewati.");
    return;
  }

  const cfg = remoteConfig();
  const days = numberValue(argValue("--days", process.env.BANYAKTAU_CLEANUP_DAYS || ""), defaultRetentionDays);
  const deleteAll = boolValue(argValue("--delete-all", process.env.BANYAKTAU_CLEANUP_DELETE_ALL || ""), false);
  const dryRun = process.argv.includes("--dry-run") || boolValue(process.env.BANYAKTAU_CLEANUP_DRY_RUN, false);
  const subdirs = csvValue(argValue("--subdirs", process.env.BANYAKTAU_CLEANUP_SUBDIRS || ""), defaultSubdirs);
  const cutoffMs = Date.now() - days * 86400000;
  const totals = { scanned: 0, deleted: 0, skipped: 0, errors: 0, freedBytes: 0 };

  console.log(`BanyakTau cleanup target: ${cfg.driver}:${cfg.remoteDir}`);
  console.log(deleteAll ? "Retention: delete all aktif." : `Retention: ${days} hari (${new Date(cutoffMs).toISOString()})`);
  console.log(`Subdirs: ${subdirs.join(", ")}`);
  if (dryRun) console.log("Mode dry-run; tidak menulis memory dan tidak menghapus file.");

  await withRemoteClient(cfg, async (client) => {
    const activeItems = normalizeMemoryPayload(await readRemoteJson(client, "state/items.json", []));
    const existingMemory = await readRemoteJson(client, "state/memory.json", { items: [] });
    const memoryItems = mergeMemory(activeItems, existingMemory);
    const keptItems = activeItems.filter((item) => itemTime(item) >= cutoffMs);

    console.log(`State aktif: ${activeItems.length} item; keep di galeri: ${keptItems.length}; memory: ${memoryItems.length} item.`);
    if (!dryRun) {
      await writeRemoteJson(client, "state/memory.json", {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: memoryItems
      });
      await writeRemoteJson(client, "state/items.json", keptItems);
    }

    for (const subdir of subdirs) {
      addStats(totals, await cleanupSubdir(client, subdir, { cutoffMs, deleteAll, dryRun }));
    }
  });

  console.log("---");
  console.log(`Selesai. scanned=${totals.scanned}, deleted=${totals.deleted}, skipped=${totals.skipped}, errors=${totals.errors}, freed=${(totals.freedBytes / 1048576).toFixed(1)}MB`);
  if (totals.errors) process.exit(2);
}

main().catch((error) => {
  console.error(`Cleanup gagal: ${error.stack || error.message}`);
  process.exit(1);
});
