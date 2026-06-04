import { ensureProjectDirs } from "./config.js";
import { ensureCarousel } from "./pipeline.js";
import { absolutizeGeneratedUrls, remoteEnabled, uploadGeneratedStateAndAssets } from "./remote.js";
import { publishCarouselToFacebook, publishCarouselToInstagram } from "./facebook.js";
import { getItem, listItems, mergeMemoryItems, saveItem } from "./storage.js";
import { publishCarouselToTikTok } from "./tiktok.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function clean(value) {
  return String(value || "").trim();
}

function carouselImageUrls(item) {
  return (item.assets?.carousels || [])
    .filter((asset) => asset?.url)
    .sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
    .map((asset) => asset.url);
}

function carouselImagePaths(item) {
  return (item.assets?.carousels || [])
    .filter((asset) => asset?.path)
    .sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
    .map((asset) => asset.path);
}

function socialDescription(item) {
  const points = (item.plan?.importantPoints || [])
    .slice(0, 3)
    .map((point) => `- ${point}`)
    .join("\n");
  return [
    item.plan?.hook || `Ternyata ${item.title} punya fakta yang jarang dibahas.`,
    cleanCaptionLine(item.plan?.summary),
    points ? `Intinya:\n${points}` : "",
    "Simpan dulu biar tidak lupa, dan kirim ke teman yang suka fakta unik.",
    "#BanyakTau #FaktaMenarik #TahukahKamu #Pengetahuan #Sains #Sejarah #EdukasiRingan"
  ].filter(Boolean).join("\n\n");
}

function cleanCaptionLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

async function pickItem() {
  const id = clean(argValue("--id", ""));
  if (id) {
    const item = await getItem(id);
    if (!item) throw new Error(`Item tidak ditemukan: ${id}`);
    return item;
  }

  const items = await listItems();
  const item = items.find((entry) => entry?.plan?.scenes?.length || entry?.assets?.carousels?.length);
  if (!item) throw new Error("Belum ada item yang bisa dipakai untuk carousel.");
  return item;
}

async function publishTarget(target, options) {
  if (target === "instagram") return publishCarouselToInstagram(options);
  if (target === "facebook") return publishCarouselToFacebook(options);
  if (target === "tiktok") return publishCarouselToTikTok(options);
  throw new Error(`Target carousel tidak didukung: ${target}`);
}

async function main() {
  ensureProjectDirs();
  const target = clean(argValue("--target", process.env.BANYAKTAU_CAROUSEL_TEST_TARGET || "instagram")).toLowerCase();
  const item = await pickItem();
  const warnings = [];

  await ensureCarousel(item, { warnings, strict: true });
  let publishItem = item;
  if (remoteEnabled()) {
    publishItem = absolutizeGeneratedUrls(item);
    await saveItem(publishItem);
    await mergeMemoryItems([publishItem]);
    await uploadGeneratedStateAndAssets({ item: publishItem });
  }

  const imageUrls = carouselImageUrls(publishItem);
  const imagePaths = carouselImagePaths(publishItem);
  if (Math.max(imageUrls.length, imagePaths.length) < 2) throw new Error("Carousel butuh minimal 2 gambar.");
  if (target !== "facebook" && !imageUrls.every((url) => /^https?:\/\//i.test(url))) {
    throw new Error("Carousel publish butuh URL publik. Isi PUBLIC_BASE_URL dan remote upload config dulu.");
  }

  const result = await publishTarget(target, {
    imageUrls,
    imagePaths,
    title: publishItem.title,
    description: socialDescription(publishItem)
  });

  const publishedAt = new Date().toISOString();
  publishItem.publish = {
    ...(publishItem.publish || {}),
    carousel: {
      ...(publishItem.publish?.carousel || {}),
      [target]: { ...result, publishedAt }
    }
  };
  await saveItem(publishItem);
  await mergeMemoryItems([publishItem]);
  if (remoteEnabled()) await uploadGeneratedStateAndAssets({ item: publishItem });

  console.log(JSON.stringify({
    status: "done",
    target,
    itemId: publishItem.id,
    title: publishItem.title,
    slideCount: imageUrls.length,
    result,
    warnings
  }, null, 2));
}

main().catch((error) => {
  console.error(`Publish carousel gagal: ${error.stack || error.message}`);
  process.exit(1);
});
