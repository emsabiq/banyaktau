import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import PImage from "pureimage";

// Generates a single test image closely matching the provided example.
// Uses background image at generated/images/carousel-demo-scene-1-*.jpg as source.

const srcBg = path.join(process.cwd(), "generated", "images", "carousel-demo-scene-1-kenapa-segel-botol-plastik-penting.jpg");
const outFile = path.join(process.cwd(), "generated", "images", "carousel-exact-test-01.jpg");

async function run() {
  const targetW = 1080;
  const targetH = 1350; // example looks portrait taller than square; choose 1080x1350

  const readStream = fsSync.createReadStream(srcBg);
  const img = await PImage.decodeJPEGFromStream(readStream);
  const canvas = PImage.make(targetW, targetH);
  const ctx = canvas.getContext("2d");

  // draw background cover
  const scale = Math.max(targetW / img.width, targetH / img.height);
  const drawW = Math.round(img.width * scale);
  const drawH = Math.round(img.height * scale);
  const dx = Math.round((targetW - drawW) / 2);
  const dy = Math.round((targetH - drawH) / 2);
  ctx.drawImage(img, dx, dy, drawW, drawH);

  // dark overlay to match mood
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.fillRect(0, 0, targetW, targetH);

  // Text block parameters (margins)
  const marginX = Math.round(targetW * 0.06);
  const bottomMargin = Math.round(targetH * 0.08);
  const textAreaW = targetW - marginX * 2;
  const textStartY = Math.round(targetH * 0.38);

  // Title lines from example
  const titleLines = ["TEKNOLOGI", "KUNO YANG HILANG", "DAN BELUM BISA", "DIBUAT LAGI"];

  // register font fallback
  // choose font and size
  const fontSize = 140; // large title
  ctx.font = `${fontSize}px Impact`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // register preferred fonts and load synchronously if possible
  let fontFamily = 'Impact';
  const tryRegister = (file, name) => {
    try {
      const f = PImage.registerFont(path.join("C:","Windows","Fonts", file), name);
      if (f && typeof f.loadSync === 'function') f.loadSync();
      return true;
    } catch (e) {
      return false;
    }
  };

  if (tryRegister('BebasNeue-Regular.otf', 'BebasNeue')) fontFamily = 'BebasNeue';
  else if (tryRegister('Aileron-Black.otf', 'AileronBlack')) fontFamily = 'AileronBlack';
  else if (tryRegister('impact.ttf', 'Impact')) fontFamily = 'Impact';

  // choose font and size (prefers BebasNeue/Aileron if available)
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // compute total height
  const lineHeight = Math.round(fontSize * 0.95);
  const totalH = lineHeight * titleLines.length;
  let y = textStartY - Math.round(totalH / 2) + lineHeight / 2;

  // draw textured gold: simulate by drawing stroke (black) then fill with gradient-ish via two fills
  for (const line of titleLines) {
    const txt = line.toUpperCase();

    // stroke: multiple offsets (tighter, less fuzzy)
    ctx.fillStyle = "#000";
    for (let dxOff = -2; dxOff <= 2; dxOff++) {
      for (let dyOff = -2; dyOff <= 2; dyOff++) {
        if (dxOff === 0 && dyOff === 0) continue;
        // skip far corners
        if (Math.abs(dxOff) === 2 && Math.abs(dyOff) === 2) continue;
        ctx.fillText(txt, Math.round(targetW / 2 + dxOff), Math.round(y + dyOff));
      }
    }

    // fill base gold and add subtle highlight + shadow for metallic look
    ctx.fillStyle = "#d49a00"; // adjusted gold base
    ctx.fillText(txt, targetW / 2, y);

    // highlight (thin, slightly above)
    ctx.fillStyle = "rgba(255,220,120,0.9)";
    ctx.fillText(txt, targetW / 2, y - Math.round(lineHeight * 0.06));

    // tiny lower shadow to deepen letter bottoms
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillText(txt, targetW / 2, y + Math.round(lineHeight * 0.04));

    y += lineHeight;
  }

  // small watermark circle top-right
  const logoText = "TWH";
  const logoX = targetW - marginX - 48;
  const logoY = marginX + 48;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.arc(logoX, logoY, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "28px Impact";
  ctx.fillText(logoText, logoX, logoY);

  // page indicator (circle with 1/7) top-right under logo
  const piX = targetW - marginX - 44;
  const piY = marginX + 44 + 110;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.beginPath(); ctx.arc(piX, piY, 28, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#FFFFFF"; ctx.font = "18px Impact"; ctx.fillText("1/7", piX, piY);

  // save
  const out = fsSync.createWriteStream(outFile);
  await PImage.encodeJPEGToStream(canvas, out, 90);
  console.log(`Wrote test image to ${outFile}`);
}

if (process.argv[1] && process.argv[1].endsWith('generate-carousel-exact.js')) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

export default run;
