import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PImage from "pureimage";
import { config, paths } from "./config.js";
import { generateSceneImage } from "./openai.js";
import { cleanText, safeFilename } from "./util.js";

const targetW = 1080;
const targetH = 1350;
const defaultSlideCount = 7;

const carouselStyle = [
  "one consistent AI-generated carousel series",
  "dark cinematic educational editorial style",
  "moody contrast, warm gold accents, realistic high-detail scene",
  "same lighting, same color grading, same dramatic atmosphere across every slide",
  "topic-specific visual evidence, concrete object or event that matches the slide",
  "no written text inside the image, no logo, no watermark"
].join(", ");

let fontCache = null;

export function buildCarouselFromItem(item = {}, options = {}) {
  const plan = item.plan || {};
  const input = item.input || {};
  const slideCount = clampNumber(options.slideCount || Number(process.env.CAROUSEL_SLIDE_COUNT || defaultSlideCount), 3, 10);
  const title = cleanDisplayText(item.title || plan.title || input.topic || "Fakta Menarik BanyakTau", 90);
  const summary = cleanDisplayText(plan.summary || plan.hook || title, 360);
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  const topic = cleanDisplayText(input.topic || title, 160);
  const slides = [];

  slides.push({
    index: 1,
    type: "title",
    titleText: title,
    bodyText: "",
    imagePrompt: buildSlideImagePrompt({ item, topic, titleText: title, bodyText: plan.hook || summary, type: "title", index: 1 })
  });

  const middleCount = Math.max(0, slideCount - 2);
  const contentScenes = pickContentScenes(scenes, middleCount);
  for (let i = 0; i < middleCount; i += 1) {
    const scene = contentScenes[i] || fallbackScene(i, topic);
    const titleText = cleanDisplayText(scene.screenText || `Fakta ${i + 1}`, 70);
    const bodyText = cleanBodyText(scene.narration || scene.visualStyle || summary, 300);
    slides.push({
      index: slides.length + 1,
      type: "content",
      titleText,
      bodyText,
      imagePrompt: buildSlideImagePrompt({ item, topic, titleText, bodyText, type: "content", index: slides.length + 1 })
    });
  }

  slides.push({
    index: slides.length + 1,
    type: "conclusion",
    titleText: closingTitle(summary),
    bodyText: cleanBodyText(summary, 300),
    imagePrompt: buildSlideImagePrompt({ item, topic, titleText: "Intinya", bodyText: summary, type: "conclusion", index: slideCount })
  });

  return {
    title,
    style: carouselStyle,
    slideCount: slides.length,
    slides
  };
}

export function buildCarouselFromPlan(plan = {}) {
  return buildCarouselFromItem({
    id: "carousel_demo",
    title: plan.title,
    input: { topic: plan.title || "BanyakTau" },
    plan
  });
}

export function buildCarouselPrompt(input = {}) {
  return [
    "Buat struktur carousel vertikal 4:5 untuk konten pengetahuan Bahasa Indonesia.",
    "Slide pertama adalah headline kuat. Slide tengah menjelaskan poin berurutan. Slide terakhir menutup dengan simpulan natural.",
    "Semua slide harus menjaga ide, tone visual, dan gaya generated image yang sama.",
    "Kembalikan JSON valid: { title, style, slideCount, slides:[{ index, type, titleText, bodyText, imagePrompt }] }.",
    input.topic ? `Topik: ${input.topic}` : "",
    input.category ? `Kategori: ${input.category}` : "",
    input.hook ? `Hook: ${input.hook}` : ""
  ].filter(Boolean).join("\n");
}

export async function generateCarouselAssets(item, options = {}) {
  if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY wajib diisi untuk generate carousel.");

  await fs.mkdir(paths.carouselDir, { recursive: true });
  const carousel = buildCarouselFromItem(item, options);
  const currentAssets = Array.isArray(item.assets?.carousels) ? [...item.assets.carousels] : [];
  const nextAssets = [];
  const warnings = options.warnings || [];
  const size = item.input?.imageSize || config.openai.imageSize;
  const quality = item.input?.imageQuality || config.openai.imageQuality;

  item.carousel = carousel;

  for (const slide of carousel.slides) {
    const filename = `${item.id}-carousel-${String(slide.index).padStart(2, "0")}-${safeFilename(carousel.title)}.jpg`;
    const localPath = path.join(paths.carouselDir, filename);

    if (fsSync.existsSync(localPath)) {
      console.log(`[Carousel] Memakai slide ${slide.index} yang sudah ada di lokal: ${localPath}`);
      const existing = currentAssets.find((asset) => Number(asset.slideIndex) === Number(slide.index)) || {};
      nextAssets.push({
        ...existing,
        slideIndex: slide.index,
        path: localPath,
        url: `/generated/carousels/${filename}`
      });
      continue;
    }

    try {
      console.log(`[Carousel] Membuat slide ${slide.index}/${carousel.slideCount} (${slide.type}) - Generate gambar background...`);
      const background = await generateCarouselBackground({ item, slide, size, quality });
      console.log(`[Carousel] Menulis konten teks ke slide ${slide.index}...`);
      const rendered = await renderCarouselSlide({
        item,
        carousel,
        slide,
        backgroundPath: background.path,
        provider: background.provider,
        prompt: background.prompt
      });
      nextAssets.push(rendered);
      console.log(`[Carousel] Slide ${slide.index} berhasil disimpan.`);
    } catch (error) {
      const message = `Carousel slide ${slide.index} gagal: ${error.message}`;
      console.error(`[Carousel] Slide ${slide.index} error: ${error.message}`);
      if (options.strict) throw new Error(message);
      warnings.push(message);
    }
  }

  item.assets = {
    ...(item.assets || {}),
    carousels: nextAssets.sort((a, b) => Number(a.slideIndex || 0) - Number(b.slideIndex || 0))
  };

  return { carousel, assets: item.assets.carousels };
}

export async function renderCarouselSlide({ item, carousel, slide, backgroundPath, provider = "local", prompt = "" }) {
  await fs.mkdir(paths.carouselDir, { recursive: true });
  const background = await decodeImage(backgroundPath);
  const canvas = PImage.make(targetW, targetH);
  const ctx = canvas.getContext("2d");
  const fonts = await loadFonts();

  drawCoverImage(ctx, background, targetW, targetH);
  drawToneLayers(ctx);
  drawChrome(ctx, {
    pageText: `${slide.index}/${carousel.slideCount}`,
    titleFont: fonts.title
  });

  if (slide.type === "title") {
    drawTitleSlide(ctx, slide, fonts);
  } else {
    drawContentSlide(ctx, slide, fonts);
  }

  const filename = `${item.id}-carousel-${String(slide.index).padStart(2, "0")}-${safeFilename(carousel.title)}.jpg`;
  const outputPath = path.join(paths.carouselDir, filename);
  const out = fsSync.createWriteStream(outputPath);
  await PImage.encodeJPEGToStream(canvas, out, 92);

  return {
    slideIndex: slide.index,
    provider,
    path: outputPath,
    url: `/generated/carousels/${filename}`,
    prompt
  };
}

async function generateCarouselBackground({ item, slide, size, quality }) {
  const scene = {
    index: slide.index,
    screenText: slide.titleText,
    imagePrompt: slide.imagePrompt
  };

  try {
    return await generateSceneImage({ itemId: `${item.id}-carousel-bg`, scene, size, quality });
  } catch (error) {
    return generateSceneImage({
      itemId: `${item.id}-carousel-bg-safe`,
      scene: {
        ...scene,
        imagePrompt: [
          `safe cinematic educational visual about ${item.input?.topic || item.title}`,
          `slide focus: ${slide.titleText}`,
          slide.bodyText ? `specific context to show: ${slide.bodyText}` : "",
          "show the actual subject being explained, not a generic dark background",
          "objects, architecture, museum display, science concept, process diagram feeling without text, no people in danger, no gore, no written text"
        ].join(", ")
      },
      size,
      quality
    });
  }
}

function buildSlideImagePrompt({ item, topic, titleText, bodyText, type, index }) {
  const itemTitle = cleanDisplayText(item.title || item.plan?.title || topic, 180);
  return [
    carouselStyle,
    `overall story title: ${itemTitle}`,
    `BanyakTau topic: ${topic}`,
    `carousel slide ${index} ${type}`,
    `visual must directly depict: ${titleText}`,
    bodyText ? `fact or narration to visualize: ${bodyText}` : "",
    "avoid generic atmosphere-only image, avoid random unrelated ruins, avoid abstract smoke-only composition",
    "use a concrete central subject, relevant location, object, material, mechanism, or before-after visual clue from the fact",
    "dramatic but readable composition, clear topic subject in upper half, lower half darker and simple for overlaid typography"
  ].filter(Boolean).join(", ");
}

function pickContentScenes(scenes, count) {
  if (!count) return [];
  if (scenes.length <= count) return scenes;
  if (count === 1) return [scenes[0]];

  const picked = [];
  const lastIndex = scenes.length - 1;
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i / (count - 1)) * lastIndex);
    picked.push(scenes[index]);
  }
  return picked;
}

function fallbackScene(index, topic) {
  return {
    screenText: index === 0 ? "Fakta pertama yang jarang disadari" : `Bagian penting ${index + 1}`,
    narration: `Fakta tentang ${topic} ini bekerja lewat proses kecil yang sering tidak terlihat.`
  };
}

function drawTitleSlide(ctx, slide, fonts) {
  const lines = fitTextLines(ctx, slide.titleText, {
    fontFamily: fonts.title,
    fontSize: 146,
    maxWidth: 950,
    maxLines: 5,
    minFontSize: 92,
    upper: true
  });
  const lineHeight = Math.round(lines.fontSize * 0.88);
  const totalHeight = lineHeight * lines.rows.length;
  let y = targetH - 72 - totalHeight + lineHeight / 2;

  for (const row of lines.rows) {
    drawGoldText(ctx, row, targetW / 2, y, {
      fontFamily: fonts.title,
      fontSize: lines.fontSize,
      align: "center"
    });
    y += lineHeight;
  }
}

function drawContentSlide(ctx, slide, fonts) {
  const title = fitTextLines(ctx, slide.titleText, {
    fontFamily: fonts.title,
    fontSize: 108,
    maxWidth: 940,
    maxLines: 2,
    minFontSize: 76,
    upper: true
  });
  const titleLineHeight = Math.round(title.fontSize * 0.9);
  const titleTotal = titleLineHeight * title.rows.length;
  let y = 785;

  for (const row of title.rows) {
    drawGoldText(ctx, row, targetW / 2, y, {
      fontFamily: fonts.title,
      fontSize: title.fontSize,
      align: "center"
    });
    y += titleLineHeight;
  }

  const body = fitTextLines(ctx, slide.bodyText, {
    fontFamily: fonts.body,
    fontSize: 54,
    maxWidth: 970,
    maxLines: titleTotal > 180 ? 5 : 7,
    minFontSize: 38,
    upper: false
  });
  const bodyLineHeight = Math.round(body.fontSize * 1.12);
  let bodyY = y + 30;

  for (const row of body.rows) {
    drawStrokeFillText(ctx, row, targetW / 2, bodyY, {
      fontFamily: fonts.body,
      fontSize: body.fontSize,
      align: "center",
      fill: "#fffdf7"
    });
    bodyY += bodyLineHeight;
  }
}

function drawToneLayers(ctx) {
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.fillRect(0, 0, targetW, targetH);

  const start = Math.round(targetH * 0.43);
  const steps = 48;
  for (let i = 0; i < steps; i += 1) {
    const p = i / (steps - 1);
    const y = Math.round(start + (targetH - start) * p);
    const h = Math.ceil((targetH - start) / steps) + 2;
    const alpha = 0.16 + Math.pow(p, 1.5) * 0.8;
    ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
    ctx.fillRect(0, y, targetW, h);
  }
}

function drawChrome(ctx, { pageText, titleFont }) {
  const pageX = targetW - 84;
  const pageY = 72;
  ctx.fillStyle = "rgba(38,38,38,0.86)";
  ctx.beginPath();
  ctx.arc(pageX, pageY, 52, 0, Math.PI * 2);
  ctx.fill();

  drawStrokeFillText(ctx, pageText, pageX, pageY + 1, {
    fontFamily: titleFont,
    fontSize: 35,
    align: "center",
    fill: "#ffffff"
  });

  drawStrokeFillText(ctx, "BANYAKTAU", targetW - 66, 154, {
    fontFamily: titleFont,
    fontSize: 58,
    align: "right",
    fill: "#ffffff"
  });
}

function drawGoldText(ctx, text, x, y, options) {
  // Plain gold fill, no effects.
  drawStrokeFillText(ctx, text, x, y, {
    ...options,
    fill: "#eda51d"
  });
}

function drawStrokeFillText(ctx, text, x, y, options) {
  const fontSize = Math.round(options.fontSize || 48);
  const fontFamily = options.fontFamily || "sans-serif";
  ctx.font = `${fontSize}px '${fontFamily}'`;
  ctx.textAlign = options.align || "center";
  ctx.textBaseline = "middle";

  // Plain single fill only: no stroke/outline, no drop shadow, no gradient.
  // Letter counters (holes inside O, A, e, etc.) stay transparent thanks to
  // the pureimage even-odd fill patch in scripts/patch-pureimage.js.
  ctx.fillStyle = options.fill || "#ffffff";
  ctx.fillText(text, x, y);
}

function fitTextLines(ctx, value, options) {
  let fontSize = Number(options.fontSize || 64);
  const minFontSize = Math.min(Number(options.minFontSize || 32), 20); // allow scaling down to 20px
  const text = options.upper ? String(value || "").toUpperCase() : String(value || "");
  let rows = [];

  while (fontSize >= minFontSize) {
    ctx.font = `${fontSize}px '${options.fontFamily}'`;
    rows = wrapText(ctx, text, options.maxWidth);
    const widest = Math.max(...rows.map((row) => ctx.measureText(row).width), 1);
    if (rows.length <= options.maxLines && widest <= options.maxWidth) break;
    fontSize -= 2;
  }

  // If it still doesn't fit within maxLines at minFontSize, try shrinking down to 14px
  if (rows.length > options.maxLines && fontSize > 14) {
    while (fontSize >= 14) {
      ctx.font = `${fontSize}px '${options.fontFamily}'`;
      rows = wrapText(ctx, text, options.maxWidth);
      const widest = Math.max(...rows.map((row) => ctx.measureText(row).width), 1);
      if (rows.length <= options.maxLines && widest <= options.maxWidth) break;
      fontSize -= 1;
    }
  }

  return { rows, fontSize };
}

function wrapText(ctx, value, maxWidth) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [String(value || "")];
}

function drawCoverImage(ctx, img, width, height) {
  const scale = Math.max(width / img.width, height / img.height);
  const drawW = Math.round(img.width * scale);
  const drawH = Math.round(img.height * scale);
  const dx = Math.round((width - drawW) / 2);
  const dy = Math.round((height - drawH) / 2);
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

async function decodeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stream = fsSync.createReadStream(filePath);
  if (ext === ".png") return PImage.decodePNGFromStream(stream);
  return PImage.decodeJPEGFromStream(stream);
}

async function loadFonts() {
  if (fontCache) return fontCache;
  fontCache = {
    title: await registerFirstFont("CarouselTitle", titleFontCandidates()),
    body: await registerFirstFont("CarouselBody", bodyFontCandidates())
  };
  return fontCache;
}

async function registerFirstFont(name, candidates) {
  for (const candidate of candidates) {
    if (!candidate || !fsSync.existsSync(candidate)) continue;
    try {
      const font = PImage.registerFont(candidate, name);
      if (font && typeof font.loadSync === "function") font.loadSync();
      else if (font && typeof font.load === "function") await new Promise((resolve) => font.load(resolve));
      return name;
    } catch {
      // Try the next candidate.
    }
  }
  return "sans-serif";
}

function titleFontCandidates() {
  return [
    process.env.CAROUSEL_TITLE_FONT_FILE,
    path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf")
  ];
}

function bodyFontCandidates() {
  return [
    process.env.CAROUSEL_BODY_FONT_FILE,
    path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf")
  ];
}

function cleanDisplayText(value, max = 200) {
  return cleanText(value, max)
    .replace(/[^\p{L}\p{N}\s.,?!:;'"()/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBodyText(value, max = 300) {
  return cleanDisplayText(value, max)
    .replace(/\b(Geser|Lanjut)\b.*$/i, "")
    .trim();
}

function closingTitle(summary) {
  const text = cleanDisplayText(summary, 64);
  const firstChunk = text.split(/[,.!?]/).find(Boolean) || "Intinya";
  const words = firstChunk.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5) return words.join(" ");
  return "Intinya";
}

function clampNumber(value, min, max) {
  const number = Math.round(Number(value || defaultSlideCount));
  if (!Number.isFinite(number)) return defaultSlideCount;
  return Math.max(min, Math.min(max, number));
}

async function runStructureDemo() {
  const demo = {
    id: "carousel_demo",
    title: "Teknologi Kuno yang Hilang dan Belum Bisa Dibuat Lagi",
    input: { topic: "teknologi kuno yang hilang" },
    plan: {
      hook: "Beberapa teknologi lama terlihat sederhana, tapi rahasianya belum selalu bisa ditiru ulang.",
      summary: "Teknologi kuno sering lahir dari bahan, lingkungan, dan kebiasaan kerja yang sulit direplikasi persis hari ini.",
      scenes: [
        { screenText: "Roman concrete", narration: "Beton Romawi bisa bertahan lama karena reaksi mineralnya terus membantu struktur menguat." },
        { screenText: "Api Yunani", narration: "Senjata laut Bizantium ini terkenal karena komposisi persisnya tidak pernah tercatat lengkap." },
        { screenText: "Baja Damaskus", narration: "Pola dan ketangguhannya berasal dari bahan bijih serta proses tempa yang sangat spesifik." },
        { screenText: "Baterai Baghdad", narration: "Artefak ini sering diperdebatkan, tapi tetap menunjukkan bagaimana teknologi lama bisa memicu banyak pertanyaan." },
        { screenText: "Mesin Antikythera", narration: "Perangkat mekanik ini menghitung gerak langit dengan roda gigi yang sangat maju untuk zamannya." }
      ]
    },
    assets: { carousels: [] }
  };
  console.log(JSON.stringify(buildCarouselFromItem(demo), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStructureDemo().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
