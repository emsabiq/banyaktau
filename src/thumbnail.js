import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "./config.js";
import { safeFilename } from "./util.js";

export async function generateThumbnail(item) {
  await fs.mkdir(paths.thumbnailDir, { recursive: true });
  const images = (item.assets?.images || []).filter((image) => image.path).slice(0, 1);
  if (!images.length) throw new Error("Gambar belum tersedia untuk thumbnail.");

  const filename = `${item.id}-thumbnail-${safeFilename(item.title)}.jpg`;
  const outputPath = path.join(paths.thumbnailDir, filename);
  const titleLines = fitLines(shortTitle(item.title || item.plan?.hook || "BanyakTau"), {
    maxChars: 20,
    maxLines: 5
  });
  const titleSize = titleFontSize(titleLines);
  const titleY = titleStartY(titleLines, titleSize);
  const titleStep = titleSize + 12;
  const textFilters = [
    ...drawLineFilters(titleLines, {
      x: 74,
      y: titleY,
      step: titleStep,
      fontsize: titleSize,
      color: "0xFFF6D7",
      borderw: 6
    })
  ];
  const filter = [
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.12:saturation=1.10:brightness=-0.01[hero]",
    "[hero]drawbox=x=0:y=980:w=1080:h=940:color=black@0.64:t=fill[panel]",
    "[panel]drawbox=x=0:y=980:w=1080:h=10:color=0xF5C84C@1:t=fill[accent]",
    "[accent]drawbox=x=74:y=1052:w=156:h=12:color=0xF5C84C@1:t=fill[base]",
    `[base]${textFilters.join(",")}`
  ].filter(Boolean).join(";");

  const args = [
    "-y",
    "-i", images[0].path,
    "-filter_complex", filter,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath
  ];

  await runFfmpeg(args);

  return {
    path: outputPath,
    url: `/generated/thumbnails/${filename}`,
    provider: "ffmpeg-collage"
  };
}

function drawLineFilters(lines, options) {
  return lines.map((line, index) => (
    `drawtext=${fontExpr()}:text='${drawtextEscape(line)}':fontcolor=${options.color}:fontsize=${options.fontsize}:bordercolor=black:borderw=${options.borderw}:x=${options.x}:y=${options.y + index * options.step}`
  ));
}

function fitLines(value, options) {
  const words = cleanDisplayText(value).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > options.maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length > options.maxLines ? fitLines(value, {
    ...options,
    maxChars: options.maxChars + 4,
    maxLines: options.maxLines
  }) : lines;
}

function titleFontSize(lines) {
  const longest = Math.max(...lines.map((line) => line.length), 1);
  if (lines.length >= 5 || longest > 24) return 74;
  if (lines.length >= 4 || longest > 20) return 84;
  if (lines.length === 3 || longest > 16) return 96;
  return 118;
}

function titleStartY(lines, fontsize) {
  const totalHeight = (lines.length * fontsize) + ((lines.length - 1) * 12);
  return Math.max(1040, 1360 - Math.round(totalHeight / 2));
}

function fontExpr() {
  const fontPath = findScholarFont() || (process.platform === "win32"
    ? "C\\:/Windows/Fonts/arialbd.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  return `fontfile='${fontPath}'`;
}

function findScholarFont() {
  const candidates = process.platform === "win32"
    ? [
        "C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/scholar-regular.otf",
        "C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/scholar-italic.otf",
        path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf").replace(/\\/g, "/"),
        "C:/Windows/Fonts/Scholar.ttf",
        "C:/Windows/Fonts/Scholar-Regular.ttf",
        "C:/Windows/Fonts/Scholar-Bold.ttf",
        "C:/Windows/Fonts/scholar.ttf",
        "C:/Windows/Fonts/scholarb.ttf"
      ]
    : [
        path.join(paths.publicDir, "assets", "fonts", "scholar-regular.otf").replace(/\\/g, "/"),
        path.join(paths.publicDir, "assets", "fonts", "scholar-italic.otf").replace(/\\/g, "/"),
        "/usr/share/fonts/truetype/scholar/Scholar.ttf",
        "/usr/share/fonts/truetype/scholar/Scholar-Bold.ttf"
      ];
  return candidates.find((candidate) => fsSync.existsSync(candidate))?.replace(/:/g, "\\:");
}

function shortTitle(value) {
  return cleanDisplayText(value)
    .replace(/\b(gimana|sih|kok|dong)\b/gi, "")
    .trim()
    .replace(/[?.!]+$/g, "");
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s.,?!-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function drawtextEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, "\\n");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, cwd: paths.rootDir });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg thumbnail gagal (${code})`));
    });
  });
}
