import fs from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import { estimateTotalCost } from "./cost.js";
import { requestKnowledgeJson } from "./openai.js";
import { clamp, cleanText, createId, nowIso } from "./util.js";

const categories = [
  "sains",
  "penemuan",
  "sejarah",
  "tubuh manusia",
  "alam semesta",
  "teknologi",
  "benda sehari-hari",
  "tokoh dunia",
  "bahasa dan budaya",
  "makanan dan dapur",
  "material dan warna",
  "peta dan navigasi",
  "suara dan musik",
  "infrastruktur tersembunyi",
  "ekologi mikro"
];

/**
 * Membuat draft naskah video panjang (landscape 16:9) memakai OpenAI GPT.
 * @param {object} rawInput - Parameter masukan dari user
 * @returns {Promise<object>} - Objek item naskah terstruktur
 */
export async function createLongformDraft(rawInput) {
  const input = normalizeInput(rawInput);
  const promptText = buildPrompt(input);
  let plan;
  let source = "offline";

  if (config.openai.apiKey) {
    try {
      console.log(`[Story Longform] Meminta naskah AI untuk topik: "${input.topic}" (${input.durationSec}s, ${input.sceneCount} scenes)...`);
      plan = await requestKnowledgeJson(promptText);
      source = "openai";
    } catch (error) {
      console.warn(`[Story Longform] Gagal memanggil OpenAI, menggunakan fallback offline: ${error.message}`);
      plan = fallbackPlan(input, error.message);
    }
  } else {
    plan = fallbackPlan(input, "OPENAI_API_KEY belum aktif.");
  }

  let normalized = normalizePlan(plan, input);
  const minimumNarrationWords = Math.round(input.durationSec * 1.75);
  if (config.openai.apiKey && narrationWordCount(normalized) < minimumNarrationWords) {
    try {
      const expandedPlan = await requestKnowledgeJson([
        promptText,
        "",
        "REVISI WAJIB:",
        `Naskah sebelumnya terlalu pendek. Tulis ulang dengan minimal ${minimumNarrationWords} kata narasi yang benar-benar dibacakan TTS.`,
        "Hitung hanya scene image dan summary. Scene reaction tidak dibacakan TTS.",
        "Setiap scene image harus 48-65 kata. Scene summary harus 55-75 kata.",
        "Pertahankan tepat jumlah scene dan pola 2 image lalu 1 reaction, dengan scene terakhir summary."
      ].join("\n"));
      normalized = normalizePlan(expandedPlan, input);
    } catch (error) {
      console.warn(`[Story Longform] Revisi panjang naskah gagal: ${error.message}`);
    }
  }
  const narrationText = normalized.scenes
    .filter((scene) => scene.sceneType !== "reaction")
    .map((scene) => scene.narration)
    .join(" ");
  const outputText = JSON.stringify(normalized);
  
  const cost = estimateTotalCost({
    promptText,
    outputText,
    sceneCount: normalized.scenes.length,
    imageSize: "1536x1024", // Landscape DALL-E 3 size
    imageQuality: input.imageQuality,
    narrationChars: narrationText.length,
    ttsProvider: input.ttsProvider,
    pricing: config.pricing
  });

  const item = {
    id: createId("tau-lf"),
    source,
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    input,
    title: normalized.title,
    plan: normalized,
    assets: {
      images: [],
      clips: [],
      audio: null,
      video: null
    },
    cost
  };

  item.assets.storyboard = await writeLongformStoryboard(item);
  return item;
}

function normalizeInput(input) {
  const durationSec = clamp(Number(input.durationSec || 300), 300, 900);
  // Long video butuh storyboard lebih banyak agar alurnya terasa dokumenter, bukan Shorts yang dipanjangin.
  const sceneCount = clamp(Number(input.sceneCount || Math.round(durationSec / 18)), 10, 28);

  return {
    topic: cleanText(input.topic || "Mengapa Kodak Bangkrut padahal mereka yang menemukan kamera digital pertama", 260),
    category: cleanText(input.category || "sejarah", 80),
    tone: cleanText(input.tone || "narrator, serius tapi menarik, informatif, mendalam, seperti video dokumenter Vox atau Lemmino", 180),
    durationSec,
    sceneCount,
    ttsProvider: String(input.ttsProvider || "elevenlabs").toLowerCase() === "openai" ? "openai" : "elevenlabs",
    imageSize: "1536x1024", // Default landscape
    imageQuality: cleanText(input.imageQuality || "standard", 20)
  };
}

function buildPrompt(input) {
  return [
    "Buat naskah video dokumenter horizontal landscape (16:9) dalam Bahasa Indonesia untuk channel BanyakTau.",
    "Video berdurasi panjang, sehingga gaya bahasanya harus mendalam, analitis, kaya akan informasi, dan mengalir seperti esai dokumenter profesional.",
    "Hindari gaya bahasa lebay atau pembuka Shorts yang berisik. Penonton video panjang mencari detail faktual ('isinya daging semua').",
    "Struktur cerita harus memiliki babak pembuka (Hook & Paradoks), isi pembahasan logis (Babak 1, 2, dst.), klimaks/analisis masalah, dan kesimpulan inspiratif di akhir.",
    "Setiap scene harus berisi narasi yang dibacakan oleh TTS dan teks layar (screenText) yang sinkron.",
    "Gunakan pola berulang: 2 scene image, lalu 1 scene reaction full-screen, kemudian ulangi pola tersebut.",
    "Scene reaction adalah jembatan singkat berupa pertanyaan atau pernyataan penasaran 8-16 kata. Jangan menjelaskan jawaban pada scene reaction; jawabannya dilanjutkan pada scene image berikutnya.",
    "Narasi scene reaction tidak akan dibacakan TTS. Teksnya hanya muncul di layar sebagai jeda hening singkat.",
    "Setiap scene image wajib memiliki 48-65 kata narasi. Scene summary wajib memiliki 55-75 kata narasi.",
    "Scene reaction tidak memerlukan visualKeywords atau imagePrompt. Isi reactionCue dengan ekspresi yang cocok: heran, kaget, skeptis, menemukan petunjuk, atau setuju.",
    "Scene terakhir wajib bertipe summary dengan screenText 'Ringkasan Inti' dan narasi kesimpulan yang tidak kosong.",
    "Buat storyboard longform yang komprehensif: banyak beat kecil, punya fungsi naratif jelas, dan tidak terasa seperti storyboard Shorts.",
    "Kembalikan JSON valid saja dengan format:",
    "{ title, hook, summary, importantPoints:[string], factCheckNote, scenes:[{ index, sceneType:'image'|'reaction'|'summary', durationSec, narration, screenText, visualKeywords, imagePrompt, chapter, beatPurpose, reactionCue }] }",
    "",
    `Topik Utama: ${input.topic}`,
    `Kategori: ${input.category}`,
    `Tone Narasi: ${input.tone}`,
    `Durasi Total: ${input.durationSec} detik`,
    `Jumlah Scene: ${input.sceneCount}`,
    `Target Jumlah Kata: sekitar ${Math.round(input.durationSec * 2.1)} kata bahasa Indonesia secara keseluruhan.`,
    "",
    "KATA KUNCI VISUAL (visualKeywords) untuk scene image/summary wajib dalam bahasa Inggris, singkat, dan relevan untuk mencari stock video.",
    "FALLBACK IMAGE PROMPT (imagePrompt) untuk scene image/summary wajib menggambarkan pemandangan horizontal 16:9 yang artistik tanpa teks/tulisan di dalamnya."
  ].join("\n");
}

function normalizePlan(plan, input) {
  const rawScenes = Array.isArray(plan?.scenes) && plan.scenes.length ? plan.scenes : [];
  const durations = distributeDurations(input.durationSec, input.sceneCount);

  const scenes = rawScenes.slice(0, input.sceneCount).map((scene, index) => {
    const duration = durations[index] || 20;
    const sceneType = normalizedSceneType(scene?.sceneType, index, input.sceneCount);
    const reactionLine = sceneType === "reaction" ? normalizeReactionNarration(scene, index) : "";
    const screenText = sceneType === "summary"
      ? "Ringkasan Inti"
      : sceneType === "reaction"
        ? reactionLine
        : cleanText(scene?.screenText || `Babak ${index + 1}`, 100);
    const narration = sceneType === "reaction"
      ? reactionLine
      : cleanText(scene?.narration || `Ini adalah bagian penjelasan untuk babak ke-${index + 1}.`, 1600);
    return {
      index: index + 1,
      sceneType,
      durationSec: duration,
      narration,
      screenText,
      visualKeywords: sceneType === "reaction" ? "" : cleanText(scene?.visualKeywords || "abstract background digital node technology", 150),
      imagePrompt: sceneType === "reaction" ? "" : cleanText(scene?.imagePrompt || `horizontal educational cinematic scene showing ${input.topic}`, 500),
      chapter: cleanText(scene?.chapter || chapterName(index, input.sceneCount), 80),
      beatPurpose: cleanText(scene?.beatPurpose || beatPurpose(index, input.sceneCount), 180),
      reactionCue: cleanText(scene?.reactionCue || reactionCue(index), 120)
    };
  });

  // Jika scene kurang dari target
  while (scenes.length < input.sceneCount) {
    const index = scenes.length;
    const sceneType = normalizedSceneType("", index, input.sceneCount);
    scenes.push({
      index: index + 1,
      sceneType,
      durationSec: durations[index] || 20,
      narration: sceneType === "reaction"
        ? fallbackReactionNarration(index)
        : `Ini adalah bagian penjelasan tambahan untuk babak ke-${index + 1}.`,
      screenText: sceneType === "summary" ? "Ringkasan Inti" : fallbackScreenText(index, input.sceneCount),
      visualKeywords: sceneType === "reaction" ? "" : "abstract background digital node technology",
      imagePrompt: sceneType === "reaction" ? "" : `horizontal educational cinematic scene showing ${input.topic}`,
      chapter: chapterName(index, input.sceneCount),
      beatPurpose: beatPurpose(index, input.sceneCount),
      reactionCue: reactionCue(index)
    });
  }

  const summary = completeSummary(plan?.summary, plan?.importantPoints, input.topic);
  const summaryScene = scenes.at(-1);
  if (summaryScene) {
    summaryScene.sceneType = "summary";
    summaryScene.screenText = "Ringkasan Inti";
    summaryScene.narration = completeSummaryNarration(summaryScene.narration, summary);
  }

  const normalized = {
    title: cleanText(plan?.title || input.topic, 100),
    hook: cleanText(plan?.hook || `Tahukah kamu tentang ${input.topic}?`, 200),
    summary,
    importantPoints: Array.isArray(plan?.importantPoints) ? plan.importantPoints.map(p => cleanText(p, 220)).slice(0, 8) : ["Poin analisis pertama."],
    factCheckNote: cleanText(plan?.factCheckNote || "Fakta diverifikasi berdasarkan data sejarah publik.", 300),
    scenes
  };
  normalized.longformStoryboard = buildLongformStoryboard(normalized);
  return normalized;
}

function distributeDurations(totalSec, count) {
  const base = Math.floor(totalSec / count);
  const remainder = totalSec % count;
  const list = Array(count).fill(base);
  for (let i = 0; i < remainder; i++) {
    list[i] += 1;
  }
  return list;
}

function fallbackPlan(input, errorMsg = "") {
  const count = input.sceneCount;
  const scenes = [];
  for (let i = 0; i < count; i++) {
    scenes.push({
      index: i + 1,
      sceneType: normalizedSceneType("", i, count),
      narration: normalizedSceneType("", i, count) === "reaction"
        ? fallbackReactionNarration(i)
        : fallbackNarration(input.topic, i, count, errorMsg),
      screenText: normalizedSceneType("", i, count) === "summary" ? "Ringkasan Inti" : fallbackScreenText(i, count),
      visualKeywords: normalizedSceneType("", i, count) === "reaction" ? "" : fallbackKeywords(i),
      imagePrompt: normalizedSceneType("", i, count) === "reaction" ? "" : fallbackImagePrompt(input.topic, i),
      chapter: chapterName(i, count),
      beatPurpose: beatPurpose(i, count),
      reactionCue: reactionCue(i)
    });
  }
  return {
    title: `Kasus ${input.topic}`,
    hook: `Mengapa ${input.topic} menjadi pelajaran penting hari ini?`,
    summary: `Analisis mendalam kegagalan inovasi dan taktik penyesuaian pasar.`,
    importantPoints: [
      "Inovasi lambat meruntuhkan raksasa industri.",
      "Zona nyaman seringkali menipu manajemen.",
      "Kompetitor agresif merebut pangsa pasar digital."
    ],
    scenes
  };
}

function buildLongformStoryboard(plan) {
  return (plan.scenes || []).map((scene) => ({
    sceneIndex: scene.index,
    sceneType: scene.sceneType || "image",
    chapter: scene.chapter || chapterName(Number(scene.index || 1) - 1, plan.scenes.length),
    durationSec: scene.durationSec,
    screenText: scene.screenText,
    narrativePurpose: scene.beatPurpose || "",
    visualKeywords: scene.visualKeywords,
    visualPrompt: scene.imagePrompt,
    reactionCue: scene.reactionCue || "",
    narrationPreview: cleanText(scene.narration, 240)
  }));
}

function normalizedSceneType(value, index, total) {
  if (index === total - 1) return "summary";
  return (index + 1) % 3 === 0 && index < total - 2 ? "reaction" : "image";
}

function normalizeReactionNarration(scene, index) {
  const candidates = [
    scene?.reactionText,
    firstSentence(scene?.narration),
    scene?.screenText,
    fallbackReactionNarration(index)
  ];
  let text = candidates.map((value) => cleanText(value, 180)).find(Boolean) || fallbackReactionNarration(index);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 16) text = words.slice(0, 16).join(" ");
  if (words.length < 6) text = `${text.replace(/[?.!]+$/g, "")}, lalu apa yang terjadi berikutnya`;
  if (!/[?.!]$/.test(text)) text = `${text}?`;
  return text;
}

function firstSentence(value) {
  return String(value || "").match(/^[^.!?]+[.!?]?/)?.[0] || "";
}

function fallbackReactionNarration(index) {
  const lines = [
    "Lalu, apa yang sebenarnya terjadi setelah perubahan besar itu?",
    "Tapi kenapa tanda penting ini justru sempat diabaikan?",
    "Di sinilah ceritanya mulai berubah. Apa penyebab utamanya?",
    "Pertanyaannya, siapa yang paling terdampak oleh keputusan tersebut?"
  ];
  return lines[index % lines.length];
}

function completeSummary(summary, importantPoints, topic) {
  const cleaned = cleanText(summary || "", 700);
  if (/[.!?]$/.test(cleaned) && cleaned.length >= 80) return cleaned;
  const points = Array.isArray(importantPoints)
    ? importantPoints.map((point) => cleanText(point, 180).replace(/[.!?]+$/g, "")).filter(Boolean).slice(0, 3)
    : [];
  const fallback = points.length
    ? points.join(". ")
    : `Pembahasan ini menunjukkan inti penting dari ${topic} dan alasan dampaknya masih relevan.`;
  const value = cleaned.length >= 80 ? cleaned : fallback;
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function completeSummaryNarration(sceneNarration, summary) {
  const sceneText = cleanText(sceneNarration || "", 1600);
  const summaryText = cleanText(summary || "", 700);
  const sceneWords = sceneText.split(/\s+/).filter(Boolean).length;
  if (sceneWords >= 50 && /[.!?]$/.test(sceneText)) return sceneText;

  const combined = [sceneText, summaryText]
    .filter(Boolean)
    .filter((value, index, values) => values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index)
    .join(" ");
  return combined || "Ringkasan inti belum tersedia.";
}

function narrationWordCount(plan) {
  return (plan.scenes || [])
    .filter((scene) => scene.sceneType !== "reaction")
    .reduce((sum, scene) => sum + String(scene.narration || "").split(/\s+/).filter(Boolean).length, 0);
}

async function writeLongformStoryboard(item) {
  const storyboardDir = path.join(paths.generatedDir, "storyboards");
  await fs.mkdir(storyboardDir, { recursive: true });
  const filename = `${item.id}-longform-storyboard.json`;
  const outputPath = path.join(storyboardDir, filename);
  await fs.writeFile(outputPath, `${JSON.stringify({
    id: item.id,
    title: item.title,
    topic: item.input.topic,
    category: item.input.category,
    durationSec: item.input.durationSec,
    sceneCount: item.plan.scenes.length,
    storyboard: item.plan.longformStoryboard || buildLongformStoryboard(item.plan)
  }, null, 2)}\n`, "utf8");
  return {
    path: outputPath,
    url: `/generated/storyboards/${filename}`,
    count: item.plan.scenes.length
  };
}

function chapterName(index, total) {
  const position = (index + 1) / Math.max(1, total);
  if (position <= 0.16) return "Hook dan konteks";
  if (position <= 0.42) return "Akar masalah";
  if (position <= 0.68) return "Analisis utama";
  if (position <= 0.88) return "Dampak dan pembalikan";
  return "Kesimpulan";
}

function beatPurpose(index, total) {
  const position = (index + 1) / Math.max(1, total);
  if (position <= 0.16) return "Membangun rasa penasaran dan pertanyaan utama.";
  if (position <= 0.42) return "Membuka data, sejarah, atau mekanisme penyebab.";
  if (position <= 0.68) return "Menjelaskan konflik inti dengan contoh konkret.";
  if (position <= 0.88) return "Memperlihatkan konsekuensi dan perubahan yang terjadi.";
  return "Menutup cerita dengan intisari yang mudah diingat.";
}

function reactionCue(index) {
  const cues = [
    "ekspresi heran singkat",
    "mengangguk karena fakta masuk akal",
    "mimik skeptis ketika data terasa mengejutkan",
    "ekspresi menemukan petunjuk",
    "reaksi kaget tanpa suara"
  ];
  return cues[index % cues.length];
}

function fallbackScreenText(index, total) {
  const labels = ["Pertanyaan Besar", "Awal Cerita", "Titik Buta", "Data Penting", "Konflik Inti", "Efek Domino", "Pembalikan", "Pelajaran"];
  return `${labels[index % labels.length]} ${Math.min(total, index + 1)}`;
}

function fallbackKeywords(index) {
  const keywords = [
    "documentary investigation office archive",
    "vintage technology factory research",
    "business meeting strategy failure",
    "macro close up documents evidence",
    "city night timelapse industry change",
    "museum display invention history"
  ];
  return keywords[index % keywords.length];
}

function fallbackImagePrompt(topic, index) {
  return [
    `horizontal cinematic documentary scene about ${topic}`,
    `story beat ${index + 1}`,
    "editorial knowledge video visual, realistic lighting, no text, no watermark"
  ].join(", ");
}

function fallbackNarration(topic, index, total, errorMsg) {
  const intro = index === 0
    ? `Bayangkan sebuah keputusan kecil yang pelan-pelan mengubah arah sebuah cerita besar. Dalam topik ${topic}, bagian paling menarik bukan cuma apa yang terjadi, tetapi kenapa banyak orang baru menyadarinya setelah dampaknya terasa.`
    : `Pada bagian ke-${index + 1}, kita masuk ke lapisan berikutnya dari ${topic}. Di sini, pola yang terlihat sederhana mulai menunjukkan hubungan sebab akibat yang lebih dalam.`;
  const context = `Kuncinya adalah membaca urutan peristiwa: siapa yang punya pilihan, informasi apa yang mereka abaikan, dan bagaimana keputusan itu menciptakan konsekuensi baru.`;
  const close = index === total - 1
    ? `Dari sini, pelajarannya jelas: fakta besar sering muncul dari detail kecil yang terus berulang sampai akhirnya tidak bisa diabaikan.`
    : `Bagian ini menjadi pijakan untuk memahami bab berikutnya, karena satu detail saja bisa mengubah cara kita melihat keseluruhan cerita.`;
  const apiNote = errorMsg ? "" : "";
  return cleanText(`${intro} ${context} ${close} ${apiNote}`, 1200);
}
