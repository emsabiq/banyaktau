import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import PImage from "pureimage";

const layoutPath = path.join(process.cwd(), "generated", "images", "carousel-demo-layout.json");

function fontFileFor(name) {
  const map = {
    "Segoe UI Semibold": "segoeuib.ttf",
    "Segoe UI": "segoeui.ttf",
    "Georgia": "georgia.ttf",
    "Arial": "arial.ttf"
  };
  const filename = map[name] || "arial.ttf";
  return path.join("C:", "Windows", "Fonts", filename);
}

async function run() {
  const data = JSON.parse(await fs.readFile(layoutPath, "utf8"));
  const outDir = path.join(process.cwd(), "generated", "images");
  const results = [];

  // Register fonts used in layout
  const fontMap = new Map();
  for (const slide of data.slides) {
    for (const block of slide.layout.textBlocks || []) {
      const fontName = block.font || "Segoe UI";
      if (fontMap.has(fontName)) continue;
      const fontPath = fontFileFor(fontName);
      try {
        const key = `font_${fontMap.size + 1}`;
        const fontObj = PImage.registerFont(fontPath, key);
        if (fontObj && typeof fontObj.loadSync === "function") {
          fontObj.loadSync();
        } else if (fontObj && typeof fontObj.load === "function") {
          await new Promise((res, rej) => fontObj.load(res));
        }
        fontMap.set(fontName, key);
      } catch (e) {
        // ignore font load errors and fallback to default
        fontMap.set(fontName, null);
      }
    }
  }

  // target output size to match example (square, Instagram-like)
  const targetW = 1080;
  const targetH = 1080;

  for (const slide of data.slides) {
    const src = path.join(process.cwd(), slide.image);
    const outFile = path.join(outDir, `carousel-demo-final-slide-${String(slide.index).padStart(2, "0")}.jpg`);
    try {
      const readStream = fsSync.createReadStream(src);
      const img = await PImage.decodeJPEGFromStream(readStream);
      // create target canvas and draw image cover-centered
      const canvas = PImage.make(targetW, targetH);
      const ctx = canvas.getContext("2d");
      // compute cover scale
      const scale = Math.max(targetW / img.width, targetH / img.height);
      const drawW = Math.round(img.width * scale);
      const drawH = Math.round(img.height * scale);
      const dx = Math.round((targetW - drawW) / 2);
      const dy = Math.round((targetH - drawH) / 2);
      ctx.drawImage(img, dx, dy, drawW, drawH);

      // darken background to make text pop
      ctx.fillStyle = "rgba(0,0,0,0.46)";
      ctx.fillRect(0, 0, targetW, targetH);

      // helper: wrap text into lines that fit within maxWidth
      function wrapText(ctx, text, maxWidth) {
        const words = String(text || "").split(/\s+/).filter(Boolean);
        const lines = [];
        let current = "";
        for (const w of words) {
          const test = current ? current + " " + w : w;
          const m = ctx.measureText ? ctx.measureText(test).width : test.length * 10;
          if (m > maxWidth && current) {
            lines.push(current);
            current = w;
          } else {
            current = test;
          }
        }
        if (current) lines.push(current);
        return lines;
      }

      function drawStrokeFillText(ctx, text, x, y, opts = {}) {
        const fill = opts.fill || "#FFD24D";

        // Draw a clean, soft drop shadow instead of a heavy outline stroke
        if (opts.shadow !== false) {
          const shadowOffset = opts.shadowOffset || Math.max(1, Math.round(fontSize * 0.035));
          ctx.fillStyle = opts.shadowColor || "rgba(0,0,0,0.65)";
          ctx.fillText(text, x + shadowOffset, y + shadowOffset);
        }

        // Fill center
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
      }

      for (const block of slide.layout.textBlocks || []) {
        // scale font sizes relative to target width
        const baseWidth = img.width || targetW;
        const scaleForFont = targetW / baseWidth;
        const fontSize = Math.max(14, Math.round(Number(block.fontSize || 28) * scaleForFont));
        const registeredKey = fontMap.get(block.font || "Segoe UI");
        if (registeredKey) ctx.font = `${fontSize}px '${registeredKey}'`;
        else ctx.font = `${fontSize}px sans-serif`;

        // compute maxWidth for wrapping (use 84% of target width by default)
        const maxWidth = Math.floor(targetW * 0.84);
        const lines = wrapText(ctx, block.text, maxWidth);

        // compute starting x,y
        const baseX = parsePercent(block.position?.x, img.width, ctx, block.text, block.align);
        const baseY = parsePercent(block.position?.y, img.height, ctx, block.text, block.align, true);

        // vertical offset to center multi-line
        const lineHeight = Math.max(18, fontSize * 1.05);
        const startY = baseY - ((lines.length - 1) * lineHeight) / 2;

        // style options: default to warm gold and black stroke
        const fillColor = block.color || block.fillColor || "#FFB400";
        const strokeColor = block.strokeColor || "#000000";
        const strokeWidth = block.strokeWidth || Math.max(2, Math.round(4 * scaleForFont));

        ctx.textAlign = block.align || "center";
        ctx.textBaseline = "middle";

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const y = startY + i * lineHeight;
          // uppercase for headline/title blocks
          const txt = (block.transform === "uppercase" || block.role === "title" || block.role === "headline") ? String(line).toUpperCase() : line;
          drawStrokeFillText(ctx, txt, baseX, y, { fill: fillColor, stroke: strokeColor, strokeWidth });
        }
      }

      const out = fsSync.createWriteStream(outFile);
      await PImage.encodeJPEGToStream(canvas, out, 90);
      results.push({ slide: slide.index, output: outFile });
      console.log(`Wrote ${outFile}`);
    } catch (err) {
      console.error(`Slide ${slide.index} failed: ${err.message}`);
      results.push({ slide: slide.index, error: String(err.message) });
    }
  }

  const manifest = path.join(outDir, "carousel-demo-final-manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ results }, null, 2), "utf8");
  console.log(`Manifest: ${manifest}`);
}

function parsePercent(value, total, ctx, text, align, isY = false) {
  if (!value) return isY ? total / 2 : total / 2;
  if (String(value).endsWith("%")) {
    const p = Number(String(value).slice(0, -1)) / 100;
    if (isY) return total * p;
    // for x, adjust by text width
    const metrics = ctx.measureText ? ctx.measureText(text) : { width: (String(text).length || 1) * 10 };
    if ((align || "center") === "center") return total * p;
    if ((align || "center") === "left") return total * p;
    if ((align || "center") === "right") return total * p;
    return total * p;
  }
  return Number(value) || 0;
}

if (process.argv[1] && process.argv[1].endsWith("render-carousel-layout-pure.js")) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

export default run;
