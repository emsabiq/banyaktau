import { config, ensureProjectDirs } from "../src/config.js";
import { createLongformDraft } from "../src/longform-story-engine.js";
import { downloadStockVideo } from "../src/pexels.js";
import { generateSceneImage } from "../src/openai.js";
import { ensureLongformSceneAudio } from "../src/pipeline.js";
import { renderLongformVideo } from "../src/longform-render.js";
import { saveItem } from "../src/storage.js";

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

ensureProjectDirs();

const topic = argValue("--topic", process.env.BANYAKTAU_LONGFORM_TOPIC || "Mengapa Kodak Bangkrut padahal mereka yang menemukan kamera digital pertama");
const durationSec = Number(argValue("--duration", "300")); // Minimal long video: 5 menit
const sceneCount = Number(argValue("--scenes", "14"));      // Storyboard longform lebih banyak dan komprehensif
const ttsProvider = argValue("--tts-provider", "openai"); // Gunakan openai (lebih murah untuk tes)
const ttsVoice = argValue("--tts-voice", "cedar");

console.log("=== MEMULAI PENGUJIAN VIDEO PANJANG (LONGFORM 16:9) ===");
console.log(`Topik: "${topic}"`);
console.log(`Durasi Target: ${durationSec} detik`);
console.log(`Jumlah Scene: ${sceneCount}`);
console.log(`TTS Provider: ${ttsProvider}`);
console.log(`TTS Voice: ${ttsVoice}`);

// 1. Generate Naskah
const item = await createLongformDraft({
  topic,
  durationSec,
  sceneCount,
  ttsProvider
});

console.log(`\n[1/5] Naskah Berhasil Dibuat: "${item.title}"`);
console.log(`Hook: "${item.plan.hook}"`);
console.log(`Summary: "${item.plan.summary}"`);
console.log(`Important Points:\n${item.plan.importantPoints.map(p => `- ${p}`).join("\n")}`);

// 2. Pengadaan Aset Visual (Video/Gambar Landscape)
console.log("\n[2/5] Mengunduh Aset Visual (Stock Video / Fallback Gambar Landscape)...");
const scenes = item.plan.scenes || [];
item.assets.clips = [];
item.assets.images = [];

for (const scene of scenes) {
  console.log(`\nScene ${scene.index}/${scenes.length}: "${scene.screenText}"`);
  if (scene.sceneType === "reaction") {
    console.log(`-> Reaction full-screen: tidak membuat gambar untuk scene ${scene.index}.`);
    continue;
  }
  
  // A. Coba cari stock video di Pexels
  let clipAsset = null;
  if (process.env.PEXELS_API_KEY) {
    try {
      clipAsset = await downloadStockVideo({
        itemId: item.id,
        sceneIndex: scene.index,
        query: scene.visualKeywords,
        targetDurationSec: scene.durationSec
      });
    } catch (err) {
      console.warn(`[Stock Video] Pencarian gagal untuk Scene ${scene.index}: ${err.message}`);
    }
  } else {
    console.log(`[Stock Video] PEXELS_API_KEY tidak ada, langsung menggunakan DALL-E.`);
  }

  if (clipAsset) {
    item.assets.clips.push(clipAsset);
    console.log(`-> Menggunakan Stock Video: ${clipAsset.path}`);
  } else {
    // B. Fallback ke DALL-E 15:6 Landscape
    console.log(`-> Mencoba Generate Gambar DALL-E Landscape (1536x1024) untuk Scene ${scene.index}...`);
    let imageAsset = null;
    let attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        imageAsset = await generateSceneImage({
          itemId: item.id,
          scene,
          size: "1536x1024", // Landscape size
          quality: config.openai.imageQuality
        });
        break; // Success!
      } catch (err) {
        console.warn(`-> [Percobaan ${attempt}/${attempts}] Gagal generate gambar: ${err.message}`);
        if (attempt === attempts) {
          throw err;
        }
        console.log("Menunggu 5 detik sebelum mencoba lagi...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    item.assets.images.push(imageAsset);
    console.log(`-> Berhasil generate gambar: ${imageAsset.path}`);
  }
}

// 3. Generate Audio Narasi (TTS per scene, termasuk reaction) & Captions
console.log("\n[3/5] Memicu TTS Voiceover per scene & Transkripsi Subtitle...");
await ensureLongformSceneAudio(item, {
  provider: ttsProvider,
  voice: ttsVoice,
  instructions: [
    "Bacakan dalam Bahasa Indonesia dengan suara laki-laki yang natural, hangat, dan percaya diri.",
    "Gaya dokumenter santai, bukan suara iklan dan bukan membaca teks secara kaku.",
    "Gunakan tempo sedang, variasikan intonasi, dan beri jeda pendek sebelum serta sesudah kalimat pertanyaan.",
    "Tekankan kata penting secara halus. Hindari nada monoton dan hindari berbicara terlalu cepat."
  ].join(" "),
  strict: true
});
console.log(`-> Berhasil membuat audio narasi per scene: ${item.assets.sceneAudio?.filter((s) => s.path).length || 0} scene`);
console.log(`-> Total subtitle segment: ${item.assets.sceneAudio?.reduce((sum, s) => sum + (s.captions?.length || 0), 0) || 0}`);

// Simpan state lokal
await saveItem(item);

// 4. Render Video Landscape 16:9 memakai FFmpeg
console.log("\n[4/5] Merender Video Landscape 16:9 dengan FFmpeg...");
const renderResult = await renderLongformVideo(item);
console.log(`\n[5/5] PROSES SELESAI DAN BERHASIL!`);
console.log(`=========================================`);
console.log(`Video Output Path: ${renderResult.path}`);
console.log(`Video Output URL : ${renderResult.url}`);
console.log(`Durasi Asli      : ${renderResult.durationSec} detik`);
console.log(`=========================================`);
