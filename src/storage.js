import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";

const itemsFile = path.join(paths.dataDir, "items.json");
const memoryFile = path.join(paths.dataDir, "memory.json");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export async function listItems() {
  const items = await readJson(itemsFile, []);
  return items.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export async function listMemoryItems() {
  const data = await readJson(memoryFile, { items: [] });
  const items = Array.isArray(data) ? data : data.items || [];
  return items.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export async function listContextItems() {
  const active = await listItems();
  const memory = await listMemoryItems();
  const activeIds = new Set(active.map((item) => item.id).filter(Boolean));
  return [
    ...active,
    ...memory.filter((item) => item.id && !activeIds.has(item.id))
  ].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export async function getItem(id) {
  const items = await readJson(itemsFile, []);
  return items.find((item) => item.id === id) || null;
}

export async function saveItem(item) {
  const items = await readJson(itemsFile, []);
  const index = items.findIndex((row) => row.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
  await writeJson(itemsFile, items);
  return item;
}

export async function mergeMemoryItems(items) {
  const existing = await listMemoryItems();
  const byId = new Map(existing.map((item) => [item.id, item]).filter(([id]) => Boolean(id)));
  for (const item of items || []) {
    const compact = compactMemoryItem(item);
    if (!compact.id) continue;
    byId.set(compact.id, {
      ...(byId.get(compact.id) || {}),
      ...compact
    });
  }
  const merged = [...byId.values()]
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, 2000);
  await writeJson(memoryFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: merged
  });
  return merged;
}

export function compactMemoryItem(item = {}) {
  return {
    id: item.id || "",
    title: item.title || item.plan?.title || "",
    topic: item.input?.topic || item.topic || "",
    category: item.input?.category || item.category || "",
    hook: item.plan?.hook || item.hook || "",
    summary: item.plan?.summary || item.summary || "",
    importantPoints: (item.plan?.importantPoints || item.importantPoints || []).slice(0, 5),
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || item.createdAt || "",
    videoUrl: item.assets?.video?.url || item.videoUrl || "",
    facebookUrl: item.publish?.facebook?.url || item.facebookUrl || "",
    instagramUrl: item.publish?.instagram?.url || item.instagramUrl || "",
    tiktokPublishId: item.publish?.tiktok?.publishId || item.tiktokPublishId || ""
  };
}
