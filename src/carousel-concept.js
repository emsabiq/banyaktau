import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

  // Draw BanyakTau watermark logo image at top-right
  const logoPath = path.join(paths.publicDir, "assets", "banyaktau-logo-watermark.png");
  try {
    if (fsSync.existsSync(logoPath)) {
      const logoImg = await decodeImage(logoPath);
      const logoW = 180;
      const logoH = Math.round(logoImg.height * (logoW / logoImg.width));
      ctx.drawImage(logoImg, targetW - 90 - logoW, 90, logoW, logoH);
    }
  } catch (err) {
    console.warn("[Carousel] Gagal menggambar logo watermark:", err.message);
  }

  const textLines = drawChrome(ctx, {
    pageText: `${slide.index}/${carousel.slideCount}`,
    titleFont: fonts.body
  });

  if (slide.type === "title") {
    textLines.push(...drawTitleSlide(ctx, slide, fonts));
  } else {
    textLines.push(...drawContentSlide(ctx, slide, fonts));
  }

  if (slide.type !== "conclusion") {
    textLines.push({
      text: "GESER → ↓",
      x: targetW - 90,
      y: 1250,
      font: fonts.body,
      fontSize: 28,
      align: "right",
      fill: "#ffffff",
      italic: false
    });
  }

  const filename = `${item.id}-carousel-${String(slide.index).padStart(2, "0")}-${safeFilename(carousel.title)}.jpg`;
  const outputPath = path.join(paths.carouselDir, filename);
  if (ffmpegAvailable() && textLines.length) {
    await renderTextWithFfmpeg({ canvas, outputPath, textLines, item, slide });
  } else {
    drawTextLayout(ctx, textLines);
    const out = fsSync.createWriteStream(outputPath);
    await PImage.encodeJPEGToStream(canvas, out, 92);
  }

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
    fontFamily: fonts.title.family,
    fontSize: 130,
    maxWidth: 900,
    maxLines: 5,
    minFontSize: 90,
    upper: true
  });
  const lineHeight = Math.round(lines.fontSize * 0.88);
  const totalHeight = lineHeight * lines.rows.length;
  // Bottom-aligned layout with left alignment matching the demo script (x=90)
  let y = targetH - 90 - totalHeight + 15;
  const textLines = [];

  for (const row of lines.rows) {
    textLines.push({
      text: row,
      x: 90,
      y,
      font: fonts.title,
      fontSize: lines.fontSize,
      align: "left",
      fill: "#eda51d"
    });
    y += lineHeight;
  }
  return textLines;
}

function drawContentSlide(ctx, slide, fonts) {
  const title = fitTextLines(ctx, slide.titleText, {
    fontFamily: fonts.title.family,
    fontSize: 145,
    maxWidth: 840,
    maxLines: 2,
    minFontSize: 90,
    upper: true
  });
  const titleLineHeight = Math.round(title.fontSize * 0.95);
  const titleTotalHeight = title.rows.length * titleLineHeight;
  const titleBottomY = 1000;
  let y = titleBottomY - titleTotalHeight;
  const textLines = [];

  for (const row of title.rows) {
    textLines.push({
      text: row,
      x: targetW / 2,
      y,
      font: fonts.title,
      fontSize: title.fontSize,
      align: "center",
      fill: "#eda51d"
    });
    y += titleLineHeight;
  }

  let body = fitTextLines(ctx, slide.bodyText, {
    fontFamily: fonts.body.family,
    fontSize: 46,
    maxWidth: 880,
    maxLines: 8,
    minFontSize: 32,
    upper: true
  });
  body.fontSize = Math.min(body.fontSize, title.fontSize - 45);
  let bodyLineHeight = Math.round(body.fontSize * 1.28);
  let bodyY = y + 24;

  // Prevent bottom overflow (keep safe margin above the swipe indicator at 1250)
  const maxY = 1220;
  let totalBodyHeight = body.rows.length * bodyLineHeight;
  while (bodyY + totalBodyHeight > maxY && body.fontSize > 24) {
    body.fontSize -= 2;
    body.fontSize = Math.min(body.fontSize, title.fontSize - 45);
    bodyLineHeight = Math.round(body.fontSize * 1.28);
    ctx.font = `${body.fontSize}px ${fonts.body.family}`;
    body.rows = wrapText(ctx, slide.bodyText.toUpperCase(), 880);
    totalBodyHeight = body.rows.length * bodyLineHeight;
  }

  for (const row of body.rows) {
    textLines.push({
      text: row,
      x: targetW / 2,
      y: bodyY,
      font: fonts.body,
      fontSize: body.fontSize,
      align: "center",
      fill: "#ffffff",
      italic: true
    });
    bodyY += bodyLineHeight;
  }
  return textLines;
}

function drawToneLayers(ctx) {
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.fillRect(0, 0, targetW, targetH);

  const start = Math.round(targetH * 0.55);
  const steps = targetH - start;
  for (let i = 0; i < steps; i += 1) {
    const p = steps <= 1 ? 1 : i / (steps - 1);
    const y = start + i;
    const alpha = 0.1 + Math.pow(p, 1.35) * 0.76;
    ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
    ctx.fillRect(0, y, targetW, 1);
  }
}

function drawChrome(ctx, { pageText, titleFont }) {
  // Page number and text indicators are disabled completely per request.
  return [];
}

async function renderTextWithFfmpeg({ canvas, outputPath, textLines, item, slide }) {
  await fs.mkdir(paths.workDir, { recursive: true });
  const workName = `${item.id}-carousel-${String(slide.index).padStart(2, "0")}`;
  const basePath = path.join(paths.workDir, `${workName}-base.jpg`);
  const textDir = path.join(paths.workDir, `${workName}-text`);
  await fs.mkdir(textDir, { recursive: true });

  const baseOut = fsSync.createWriteStream(basePath);
  await PImage.encodeJPEGToStream(canvas, baseOut, 94);

  const goldTexturePath = path.join(paths.publicDir, "assets", "gold-texture.png");
  const hasTexture = false;
  const inputs = ["-i", basePath];

  const graph = ["[0:v]format=rgba[base0]"];
  if (hasTexture) {
    graph.push(`[1:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}[tex_scaled]`);
  }

  for (let i = 0; i < textLines.length; i += 1) {
    const line = textLines[i];
    const textFile = path.join(textDir, `line-${String(i + 1).padStart(2, "0")}.txt`);
    await fs.writeFile(textFile, line.text, "utf8");
    graph.push(`${drawTextFilter(line, textFile, hasTexture)}[txt${i}]`);

    const yVal = Math.max(0, Math.round(line.y - line.fontSize * 0.56));
    const shearShift = line.italic ? Math.round(0.10 * (yVal - targetH / 2)) : 0;
    const overlayX = shearShift;

    // If it's a gold line (fill: "#eda51d") and texture is available, apply alphamerge
    if (line.fill === "#eda51d" && hasTexture) {
      graph.push(`[tex_scaled][txt${i}]alphamerge[tex_line_${i}]`);
      graph.push(`[base${i}][tex_line_${i}]overlay=${overlayX}:0:format=rgb[base${i + 1}]`);
    } else {
      graph.push(`[base${i}][txt${i}]overlay=${overlayX}:0:format=rgb[base${i + 1}]`);
    }
  }
  const outputLabel = `[base${textLines.length}]`;

  const result = spawnSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", outputLabel,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath
  ], { encoding: "utf8", windowsHide: true });

  if (result.status !== 0) {
    throw new Error(`FFmpeg text render gagal: ${result.stderr || result.error?.message || "unknown error"}`);
  }
}

function drawTextFilter(line, textFile, hasTexture = false) {
  const fontPart = line.font.file
    ? `fontfile='${escapeFfmpegPath(line.font.file)}'`
    : "font='serif'";
  const y = Math.max(0, Math.round(line.y - line.fontSize * 0.56));
  
  // If we are texturing this gold line, draw it in solid white to act as a mask
  const fillVal = (line.fill === "#eda51d" && hasTexture) ? "#ffffff" : line.fill;

  const drawText = [
    `drawtext=${fontPart}`,
    `textfile='${escapeFfmpegPath(textFile)}'`,
    `fontsize=${Math.round(line.fontSize)}`,
    `fontcolor=${ffmpegColor(fillVal)}`,
    `x=${textXExpression(line, y)}`,
    `y=${y}`,
    "fix_bounds=1"
  ].join(":");
  const filters = [
    `color=color=black@0.0:size=${targetW}x${targetH}`,
    "format=rgba",
    drawText
  ];
  if (line.italic) {
    filters.push("shear=shx=0.10:fillcolor=black@0.0");
  }
  return filters.join(",");
}

function textXExpression(line, y = 0) {
  const x = Math.round(line.x);
  if (line.align === "center") return `${x}-text_w/2`;
  if (line.align === "right" || line.align === "end") return `${x}-text_w`;
  return String(x);
}

function escapeFfmpegPath(filePath) {
  return path.resolve(filePath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function ffmpegColor(value) {
  const color = String(value || "#ffffff").trim();
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
}

function ffmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function drawTextLayout(ctx, lines) {
  for (const line of lines) {
    drawCanvasTextLine(ctx, line);
  }
}

function drawCanvasTextLine(ctx, line) {
  if (!line.italic) {
    drawStrokeFillText(ctx, line.text, line.x, line.y, {
      fontFamily: line.font.family,
      fontSize: line.fontSize,
      align: line.align,
      fill: line.fill
    });
    return;
  }

  ctx.save();
  ctx.translate(line.x, line.y);
  ctx.transform(1, 0, 0.10, 1, 0, 0);
  drawStrokeFillText(ctx, line.text, 0, 0, {
    fontFamily: line.font.family,
    fontSize: line.fontSize,
    align: line.align,
    fill: line.fill
  });
  ctx.restore();
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
  ctx.font = `${fontSize}px ${fontFamily}`;
  const align = options.align || "center";
  const baseline = "middle";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // Draw each glyph separately. PureImage can produce horizontal artifacts when
  // it fills a whole sentence as one path, especially with large display text.
  ctx.fillStyle = options.fill || "#ffffff";
  const chars = textGraphemes(text);
  let cursor = align === "right" || align === "end"
    ? x - measureTextWidth(ctx, chars)
    : align === "center"
      ? x - measureTextWidth(ctx, chars) / 2
      : x;

  for (const char of chars) {
    if (char !== " ") ctx.fillText(char, cursor, y);
    cursor += measureTextWidth(ctx, [char]);
  }
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

function fitTextLines(ctx, value, options) {
  let fontSize = Number(options.fontSize || 64);
  const minFontSize = Math.min(Number(options.minFontSize || 32), 20); // allow scaling down to 20px
  const text = options.upper ? String(value || "").toUpperCase() : String(value || "");
  let rows = [];

  while (fontSize >= minFontSize) {
    ctx.font = `${fontSize}px ${options.fontFamily}`;
    rows = wrapText(ctx, text, options.maxWidth);
    const widest = Math.max(...rows.map((row) => measureTextWidth(ctx, row)), 1);
    if (rows.length <= options.maxLines && widest <= options.maxWidth) break;
    fontSize -= 2;
  }

  // If it still doesn't fit within maxLines at minFontSize, try shrinking down to 14px
  if (rows.length > options.maxLines && fontSize > 14) {
    while (fontSize >= 14) {
      ctx.font = `${fontSize}px ${options.fontFamily}`;
      rows = wrapText(ctx, text, options.maxWidth);
      const widest = Math.max(...rows.map((row) => measureTextWidth(ctx, row)), 1);
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
    if (measureTextWidth(ctx, next) > maxWidth && line) {
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
      return { family: name, file: candidate };
    } catch {
      // Try the next candidate.
    }
  }
  return { family: "sans-serif", file: "" };
}

function titleFontCandidates() {
  return [
    path.join(paths.publicDir, "assets", "fonts", "BebasNeue-Regular.otf"),
    path.join(paths.publicDir, "assets", "fonts", "PlusJakartaSans-ExtraBold.ttf"),
    process.env.CAROUSEL_TITLE_FONT_FILE,
    windowsScholarFontPath(),
    path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf"),
    path.join(paths.publicDir, "assets", "fonts", "PlusJakartaSans-Bold.ttf")
  ];
}

function bodyFontCandidates() {
  return [
    path.join(paths.publicDir, "assets", "fonts", "PlusJakartaSans-Bold.ttf"),
    process.env.CAROUSEL_BODY_FONT_FILE,
    path.join(paths.publicDir, "assets", "fonts", "PlusJakartaSans-Regular.ttf"),
    windowsScholarFontPath(),
    path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf")
  ];
}

function windowsScholarFontPath() {
  return path.join(process.env.LOCALAPPDATA || "C:\\Users\\Lenovo\\AppData\\Local", "Microsoft", "Windows", "Fonts", "SCHOLAR-REGULAR.OTF");
}

function measureTextWidth(ctx, value) {
  const chars = Array.isArray(value) ? value : textGraphemes(value);
  return chars.reduce((total, char) => total + measureGlyphWidth(ctx, char), 0);
}

function measureGlyphWidth(ctx, char) {
  const width = ctx.measureText(char).width;
  if (/\s/.test(char)) {
    const fallback = Math.max(ctx.measureText("n").width * 0.48, Number(ctx._font?.size || 48) * 0.24);
    return Math.max(width, fallback);
  }
  return width;
}

function textGraphemes(value) {
  const text = String(value || "");
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter("id", { granularity: "grapheme" });
    return [...segmenter.segment(text)].map((entry) => entry.segment);
  }
  return Array.from(text);
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
