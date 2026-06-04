import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import PImage from "pureimage";
import { renderCarouselSlide } from "./src/carousel-concept.js";

async function main() {
  console.log("Loading items...");
  const itemsRaw = await fs.readFile(path.join("data", "items.json"), "utf8");
  const items = JSON.parse(itemsRaw);
  
  const item = items.find(i => i.id === "tau_af8bcbde001a");
  if (!item) { console.error("Item not found!"); return; }
  console.log("Item found:", item.title);

  // Quick font test: render body text directly to check lowercase vs uppercase
  const testCanvas = PImage.make(1080, 400);
  const ctx = testCanvas.getContext("2d");

  // Register Segoe UI directly
  const segoeUIPath = "C:/Windows/Fonts/segoeui.ttf";
  if (fsSync.existsSync(segoeUIPath)) {
    const f = PImage.registerFont(segoeUIPath, "TestSegoeUI");
    if (f && typeof f.loadSync === "function") f.loadSync();
    else if (f && typeof f.load === "function") await new Promise(r => f.load(r));
    console.log("Segoe UI loaded OK");
  } else {
    console.log("Segoe UI NOT FOUND at", segoeUIPath);
  }

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, 1080, 400);

  ctx.font = "48px 'TestSegoeUI'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Saat kamu menggali tanah di kebun,", 540, 80);
  ctx.fillText("ada dunia tersembunyi yang penuh.", 540, 140);

  // Also test with Bebas Neue for comparison
  const bebasPath = path.join("public", "assets", "fonts", "BebasNeue-Regular.otf");
  if (fsSync.existsSync(bebasPath)) {
    const f2 = PImage.registerFont(bebasPath, "TestBebas");
    if (f2 && typeof f2.loadSync === "function") f2.loadSync();
    else if (f2 && typeof f2.load === "function") await new Promise(r => f2.load(r));
  }
  ctx.font = "48px 'TestBebas'";
  ctx.fillStyle = "#ffd54f";
  ctx.fillText("BEBAS NEUE: MIKROORGANISME TANAH", 540, 220);

  // Scholar italic
  const scholarPath = path.join("public", "assets", "fonts", "scholar-italic.otf");
  if (fsSync.existsSync(scholarPath)) {
    const f3 = PImage.registerFont(scholarPath, "TestScholar");
    if (f3 && typeof f3.loadSync === "function") f3.loadSync();
    else if (f3 && typeof f3.load === "function") await new Promise(r => f3.load(r));
  }
  ctx.font = "48px 'TestScholar'";
  ctx.fillStyle = "#aaffaa";
  ctx.fillText("Scholar Italic: ada dunia tersembunyi", 540, 300);
  ctx.fillText("yang penuh dengan makhluk kecil.", 540, 360);

  const out = fsSync.createWriteStream("public/fonts-test-compare.jpg");
  await PImage.encodeJPEGToStream(testCanvas, out, 92);
  console.log("Font comparison saved to public/fonts-test-compare.jpg");

  // Now render the actual slides
  const carouselPlan = item.carousel || {
    title: item.title,
    slideCount: 7,
    slides: [
      { index: 1, type: "title", titleText: item.title, bodyText: "" },
      { index: 2, type: "content", titleText: "Dunia Tersembunyi di Kebunmu",
        bodyText: "Satu sendok teh tanah kebun yang sehat mengandung miliaran mikroorganisme aktif. Mereka bekerja 24 jam mengolah nutrisi agar tanaman tumbuh subur." }
    ]
  };

  console.log("Rendering Slide 1...");
  const bg1 = path.join("generated", "images", "tau_af8bcbde001a-carousel-bg-scene-1-mikroorganisme-rahasia-di-dalam-tanah-kebunmu.jpg");
  const result1 = await renderCarouselSlide({ item, carousel: carouselPlan, slide: carouselPlan.slides[0], backgroundPath: bg1 });
  await fs.copyFile(result1.path, path.join("public", "fonts-demo-1.jpg"));
  console.log("Slide 1 done.");

  console.log("Rendering Slide 2...");
  const bg2 = path.join("generated", "images", "tau_af8bcbde001a-carousel-bg-scene-2-mikroorganisme-tanah-dunia-tersembunyi-di-kebunmu.jpg");
  const result2 = await renderCarouselSlide({ item, carousel: carouselPlan, slide: carouselPlan.slides[1], backgroundPath: bg2 });
  await fs.copyFile(result2.path, path.join("public", "fonts-demo-2.jpg"));
  console.log("Slide 2 done.");

  console.log("All done!");
}

main().catch(console.error);
