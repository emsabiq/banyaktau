import { buildCarouselFromPlan } from "./carousel-concept.js";
import { generateSceneImage } from "./openai.js";
import { config } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";

const demoPlan = {
  title: "Kenapa segel botol plastik penting?",
  hook: "Segel kecil itu menjaga kualitas dan memberi kepastian kalau botol belum dibuka.",
  summary: "Segel botol adalah perlindungan kecil yang membuat minuman lebih aman dan mudah dikenali.",
  scenes: [
    { screenText: "Apa fungsi segel botol?", narration: "Segel menunjukkan bahwa produk belum dibuka dan belum disentuh.", visualStyle: "clean documentary" },
    { screenText: "Bagaimana segel membantu keamanan?", narration: "Saat segel terputus, itu tanda visual bahwa botol sudah dibuka.", visualStyle: "illustrative close-up" }
  ]
};

async function run() {
  const carousel = buildCarouselFromPlan(demoPlan);
  const results = [];
  await fs.mkdir(path.join(process.cwd(), "generated", "images"), { recursive: true });

  for (const slide of carousel.slides) {
    try {
      // adapt to generateSceneImage signature
      const scene = {
        index: slide.index,
        imagePrompt: slide.imagePrompt,
        screenText: slide.screenText
      };
      const img = await generateSceneImage({ itemId: `carousel-demo`, scene, size: config.openai.imageSize, quality: config.openai.imageQuality });
      results.push({ slide: slide.index, path: img.path, url: img.url });
      console.log(`Slide ${slide.index} -> ${img.path}`);
    } catch (error) {
      console.error(`Slide ${slide.index} generation failed: ${error.message}`);
      results.push({ slide: slide.index, error: String(error.message) });
    }
  }

  const out = path.join(process.cwd(), "generated", "images", "carousel-demo-manifest.json");
  await fs.writeFile(out, JSON.stringify({ carousel: { title: carousel.title }, results }, null, 2), "utf8");
  console.log(`Manifest written to ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith("generate-carousel-images.js")) {
  try {
    await run();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

export default run;
