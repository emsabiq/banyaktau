import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const layoutPath = path.join(process.cwd(), "generated", "images", "carousel-demo-layout.json");

function fontFileFor(name) {
  const map = {
    "Segoe UI Semibold": "segoeuib.ttf",
    "Segoe UI": "segoeui.ttf",
    "Georgia": "georgia.ttf",
    "Arial": "arial.ttf"
  };
  const filename = map[name] || map[Object.keys(map).find((k) => name?.includes(k))] || "arial.ttf";
  return path.join("C:", "Windows", "Fonts", filename);
}

function percentToExpr(value, axis) {
  if (!value) return axis === "x" ? "(w-text_w)/2" : "(h-text_h)/2";
  if (String(value).endsWith("%")) {
    const p = Number(String(value).slice(0, -1)) / 100;
    if (axis === "x") return `(w*${p.toFixed(4)} - text_w/2)`;
    return `(h*${p.toFixed(4)} - text_h/2)`;
  }
  // numeric px
  const n = Number(value);
  if (axis === "x") return `${n}`;
  return `${n}`;
}

async function run() {
  const data = JSON.parse(await fs.readFile(layoutPath, "utf8"));
  const outDir = path.join(process.cwd(), "generated", "images");
  const results = [];

  for (const slide of data.slides) {
    const src = path.join(process.cwd(), slide.image);
    const outFile = path.join(outDir, `carousel-demo-mockup-slide-${String(slide.index).padStart(2, "0")}.jpg`);
    const textFiles = [];
    const drawtexts = [];

    for (let i = 0; i < (slide.layout.textBlocks || []).length; i++) {
      const block = slide.layout.textBlocks[i];
      const tf = path.join(outDir, `carousel-slide-${slide.index}-block-${i + 1}.txt`);
      await fs.writeFile(tf, block.text, "utf8");
      textFiles.push(tf);

      const fontfile = fontFileFor(block.font || "Arial").replace(/\\/g, "\\\\");
      const fontsize = Number(block.fontSize || 28);
      const fontcolor = block.color || "#FFFFFF";
      const shadow = block.shadow ? `:shadowcolor=black:shadowx=2:shadowy=2` : "";
      const x = percentToExpr(block.position?.x, "x");
      const y = percentToExpr(block.position?.y, "y");

      // Read text and escape for ffmpeg drawtext
      let text = (block.text || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      // Escape colon and percent
      text = text.replace(/:/g, "\\:").replace(/%/g, "%%");

      const dt = `drawtext=fontfile='${fontfile}':text='${text}':fontsize=${fontsize}:fontcolor=${fontcolor}:x=${x}:y=${y}${shadow}:box=0`;
      drawtexts.push(dt);
    }

    const vf = drawtexts.join(",");
    const args = ["-y", "-i", src, "-vf", vf, "-q:v", "3", outFile];
    const proc = spawnSync("ffmpeg", args, { encoding: "utf8" });
    if (proc.status !== 0) {
      console.error(proc.stderr || proc.stdout);
      results.push({ slide: slide.index, error: proc.stderr || proc.stdout });
    } else {
      results.push({ slide: slide.index, output: outFile });
    }
  }

  const manifest = path.join(outDir, "carousel-demo-mockup-manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ results }, null, 2), "utf8");
  console.log(`Wrote manifest to ${manifest}`);
}

if (process.argv[1] && process.argv[1].endsWith("render-carousel-layout.js")) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

export default run;
