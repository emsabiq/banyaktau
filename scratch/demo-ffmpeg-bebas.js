import { spawnSync } from "node:child_process";
import path from "node:path";
import fsSync from "node:fs";

// Background images (clean source images from the workspace)
const bgImage1 = path.resolve("generated", "images", "carousel-demo-scene-1-kenapa-segel-botol-plastik-penting.jpg");
const bgImage2 = path.resolve("generated", "images", "carousel-demo-scene-2-apa-fungsi-segel-botol.jpg");
const logoImage = path.resolve("public", "assets", "banyaktau-logo-watermark.png");

// Fonts
const titleFont = path.resolve("public", "assets", "fonts", "BebasNeue-Regular.otf");
const bodyFont = path.resolve("public", "assets", "fonts", "PlusJakartaSans-Bold.ttf");

// Outputs
const outputFile1 = path.resolve("public", "demo-bebas-slide1.jpg");
const outputFile2 = path.resolve("public", "demo-bebas-slide2.jpg");

function escapeFfmpegPath(filePath) {
  return path.resolve(filePath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    const test = current ? current + " " + w : w;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function renderSlide1() {
  console.log("\n--- RENDERING SLIDE 1 (Title Slide - Clean Gold) ---");
  const escapedTitleFont = escapeFfmpegPath(titleFont);

  const titleLines = [
    "TEKNOLOGI",
    "KUNO YANG HILANG",
    "DAN BELUM BISA",
    "DIBUAT LAGI"
  ];

  const filters = [];
  
  // 1. Scale and crop background
  filters.push("[0:v]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350[scaled]");
  
  // 2. Dark overlay (55% opacity)
  filters.push("[scaled]drawbox=y=0:color=black@0.55:width=iw:height=ih:t=fill[darkened]");

  // 3. Overlay BanyakTau logo (top right)
  filters.push(`[1:v]scale=180:-1,format=rgba[logo]`);
  filters.push(`[darkened][logo]overlay=1080-90-w:90[bg_final]`);

  // 4. Draw title lines directly on the background
  let lastLabel = "bg_final";
  const titleSize = 130;
  const titleLineHeight = 115;
  const startY = 1350 - 90 - (titleLines.length * titleLineHeight) + 15;

  for (let i = 0; i < titleLines.length; i++) {
    const line = titleLines[i].toUpperCase();
    const currentY = startY + i * titleLineHeight;
    const nextLabel = `title_line${i}`;
    const escapedText = line.replace(/:/g, "\\:").replace(/'/g, "\\'");
    filters.push(`[${lastLabel}]drawtext=fontfile='${escapedTitleFont}':text='${escapedText}':fontsize=${titleSize}:fontcolor=0xeda51d:x=90:y=${currentY}[${nextLabel}]`);
    lastLabel = nextLabel;
  }

  const finalFilter = filters.join(";");

  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", bgImage1,
    "-i", logoImage,
    "-filter_complex", finalFilter,
    "-map", `[${lastLabel}]`,
    "-frames:v", "1",
    "-q:v", "2",
    outputFile1
  ], { encoding: "utf8", windowsHide: true });

  if (result.status === 0) {
    console.log("Slide 1 generated successfully!");
    console.log("Saved to:", outputFile1);
  } else {
    console.error("FFmpeg Slide 1 error:", result.stderr || result.error?.message);
  }
}

async function renderSlide2() {
  console.log("\n--- RENDERING SLIDE 2 (Content Slide - Clean Gold & Italic White) ---");
  const escapedTitleFont = escapeFfmpegPath(titleFont);
  const escapedBodyFont = escapeFfmpegPath(bodyFont);

  const titleText = "ROMAN CONCRETE";
  const bodyText = "BETON ROMAWI DIGUNAKAN UNTUK MEMBANGUN PELABUHAN, KUIL, DAN BANGUNAN YANG MASIH BERTAHAN HINGGA SEKARANG. BERBEDA DENGAN BETON MODERN YANG BISA RETAK, MATERIAL INI JUSTRU MENGUAT SAAT TERKENA AIR LAUT.";

  // Dynamic Title Sizing Heuristic
  let titleSize = 135;
  if (titleText.length > 25) {
    titleSize = 90;
  } else if (titleText.length > 15) {
    titleSize = 110;
  }

  // Dynamic Body Sizing Heuristic
  let bodySize = 42;
  let wrapLimit = 31;
  if (bodyText.length > 250) {
    bodySize = 32;
    wrapLimit = 38;
  } else if (bodyText.length > 150) {
    bodySize = 36;
    wrapLimit = 34;
  }

  const bodyLines = wrapText(bodyText, wrapLimit);

  const filters = [];
  
  // 1. Scale and crop background
  filters.push("[0:v]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350[scaled]");
  
  // 2. Dark overlay (55% opacity)
  filters.push("[scaled]drawbox=y=0:color=black@0.55:width=iw:height=ih:t=fill[darkened]");

  // 3. Overlay BanyakTau logo (top right)
  filters.push(`[1:v]scale=180:-1,format=rgba[logo]`);
  filters.push(`[darkened][logo]overlay=1080-90-w:90[bg_final]`);

  // 4. Draw centered title in solid gold directly on the background
  const titleLineHeight = Math.round(titleSize * 0.95);
  const titleBottomY = 820;
  const titleY = titleBottomY - 1 * titleLineHeight; // ROMAN CONCRETE is 1 line
  filters.push(`[bg_final]drawtext=fontfile='${escapedTitleFont}':text='${titleText}':fontsize=${titleSize}:fontcolor=0xeda51d:x=(w-text_w)/2:y=${titleY}[bg_with_title]`);

  // 5. Draw white body lines slanted to the right (shx=0.10) dynamically below the title
  let lastLabel = "bg_with_title";
  const bodyLineHeight = Math.round(bodySize * 1.28);
  const startY = titleBottomY + 6;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].toUpperCase();
    const currentY = startY + i * bodyLineHeight;
    
    const textCanvasLabel = `tcanvas${i}`;
    const drawnTextLabel = `tdrawn${i}`;
    const slantedLabel = `tslant${i}`;
    const nextLabel = `body${i}`;

    const escapedText = line.replace(/:/g, "\\:").replace(/'/g, "\\'");
    
    filters.push(`color=color=black@0.0:size=1080x1350,format=rgba[${textCanvasLabel}]`);
    filters.push(`[${textCanvasLabel}]drawtext=fontfile='${escapedBodyFont}':text='${escapedText}':fontsize=${bodySize}:fontcolor=white:x=(w-text_w)/2:y=${currentY}[${drawnTextLabel}]`);
    filters.push(`[${drawnTextLabel}]shear=shx=0.10:fillcolor=black@0.0[${slantedLabel}]`);
    const overlayX = Math.round(0.10 * (currentY - 1350 / 2));
    filters.push(`[${lastLabel}][${slantedLabel}]overlay=${overlayX}:0:format=rgb[${nextLabel}]`);
    
    lastLabel = nextLabel;
  }

  const finalFilter = filters.join(";");

  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", bgImage2,
    "-i", logoImage,
    "-filter_complex", finalFilter,
    "-map", `[${lastLabel}]`,
    "-frames:v", "1",
    "-q:v", "2",
    outputFile2
  ], { encoding: "utf8", windowsHide: true });

  if (result.status === 0) {
    console.log("Slide 2 generated successfully!");
    console.log("Saved to:", outputFile2);
  } else {
    console.error("FFmpeg Slide 2 error:", result.stderr || result.error?.message);
  }
}

async function main() {
  console.log("Checking background image 1:", fsSync.existsSync(bgImage1));
  console.log("Checking background image 2:", fsSync.existsSync(bgImage2));
  console.log("Checking logo image:", fsSync.existsSync(logoImage));
  console.log("Checking title font file:", fsSync.existsSync(titleFont));
  console.log("Checking body font file:", fsSync.existsSync(bodyFont));

  await renderSlide1();
  await renderSlide2();
}

main().catch(console.error);
