import { config } from "./config.js";
import { estimateTotalCost } from "./cost.js";
import { requestIdeaJson, requestKnowledgeJson } from "./openai.js";
import { clamp, cleanText, createId, nowIso } from "./util.js";

const categories = [
  "sains",
  "penemuan",
  "sejarah",
  "tubuh manusia",
  "alam semesta",
  "teknologi",
  "benda sehari-hari",
  "tokoh dunia"
];

function normalizeIdeaInput(input) {
  const category = cleanText(input.category || "random", 80);
  const randomCategory = categories[Math.floor(Math.random() * categories.length)];
  return {
    seed: cleanText(input.seed || input.topic || "", 260),
    category: category === "random" ? randomCategory : category,
    durationSec: clamp(Number(input.durationSec || 90), 45, 120)
  };
}

function buildIdeaPrompt(input, context) {
  const recent = Array.isArray(context.existingItems)
    ? context.existingItems.slice(0, 90).map((item) => `- ${item.title}: ${item.plan?.hook || item.hook || item.input?.topic || item.topic || ""}`)
    : [];

  return [
    "Buat 10 rekomendasi ide video pendek untuk channel BanyakTau.",
    "Channel ini berisi pengetahuan ringan: sains, sejarah, penemuan, tubuh manusia, alam semesta, teknologi, benda sehari-hari, dan tokoh dunia.",
    "Kamu yang menentukan hook dan judul; jangan beri template kosong dan jangan meminta user mengisi hook sendiri.",
    "Judul harus siap pakai untuk YouTube Shorts: singkat, jelas, maksimal 70 karakter, tanpa slang pembuka seperti 'gimana sih', dan kuat dibaca di thumbnail.",
    "Setiap ide harus punya rasa penasaran kuat, mudah divisualkan dengan gambar AI, dan bisa dijelaskan faktual dalam maksimal 2 menit.",
    "Pilih ide yang hemat produksi: cukup gambar AI + TTS. Jangan menyarankan cuplikan video AI, footage, b-roll video, atau proses yang butuh video generator.",
    "Prioritas ide: luar biasa, jarang dipilih channel edukasi umum, punya kontras kuat, dan terasa seperti penonton menemukan pintu rahasia dari benda biasa.",
    "Setiap ide harus benar-benar berbeda dari riwayat. Jangan ulang judul, objek utama, mekanisme penjelasan, atau hook yang mirip dengan daftar riwayat.",
    "Jika riwayat banyak berisi sains dasar, geser ke sejarah benda, asal-usul kebiasaan, detail teknologi tersembunyi, atau fenomena alam yang belum muncul.",
    "Jangan pilih klaim medis/keuangan/hukum yang berisiko, teori konspirasi, atau topik yang butuh wajah figur publik modern.",
    "Bahasa hook harus natural seperti kreator Indonesia, bukan judul artikel kaku. Hindari kata yang terlalu lebay seperti ajaib, tergila-gila, dan klaim bombastis tanpa dasar.",
    "Kembalikan JSON valid saja dengan shape:",
    "{ ideas:[{ title, topic, hook, category, angle, whyGood, visualPotential:[string], riskLevel, estimatedDurationSec }] }",
    input.seed ? `Arah topik dari user: ${input.seed}` : "Arah topik dari user: bebas, cari ide paling menarik.",
    `Kategori prioritas: ${input.category}`,
    `Durasi target: ${input.durationSec} detik`,
    recent.length ? `Riwayat/log yang wajib dihindari:\n${recent.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function normalizeIdeas(ideas, input) {
  const rows = Array.isArray(ideas) && ideas.length ? ideas : fallbackIdeas(input);
  const seen = new Set();
  const normalized = [];

  for (const idea of rows) {
    const title = cleanPublicTitle(idea?.title || idea?.topic || input.seed || "Fakta yang Jarang Dibahas");
    const hook = cleanText(idea?.hook || `Ternyata ${title.toLowerCase()} punya cerita yang jarang dibahas.`, 180);
    const key = `${title}|${hook}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: createId("idea"),
      title,
      topic: cleanText(idea?.topic || title, 220),
      hook,
      category: cleanText(idea?.category || input.category, 80),
      angle: cleanText(idea?.angle || "Dibuka dari rasa penasaran, lalu dijelaskan dengan analogi sederhana.", 220),
      whyGood: cleanText(idea?.whyGood || "Topik dekat dengan penonton dan mudah divisualkan.", 220),
      visualPotential: normalizeStringList(idea?.visualPotential, 4),
      riskLevel: cleanText(idea?.riskLevel || "rendah", 40),
      estimatedDurationSec: clamp(Number(idea?.estimatedDurationSec || input.durationSec), 45, 120)
    });
    if (normalized.length >= 10) break;
  }

  const fallbackRows = fallbackIdeas(input);
  while (normalized.length < 10) {
    const fallback = fallbackRows[normalized.length % fallbackRows.length];
    normalized.push({
      ...fallback,
      id: createId("idea")
    });
  }

  return normalized;
}

export function selectMostNovelIdea(ideas = [], existingItems = []) {
  const candidates = Array.isArray(ideas) ? ideas.filter(Boolean) : [];
  if (!candidates.length) return null;
  const historyDocs = (Array.isArray(existingItems) ? existingItems : [])
    .slice(0, 160)
    .map(historyText)
    .filter(Boolean);
  if (!historyDocs.length) return candidates[0];

  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const idea of candidates) {
    const text = ideaText(idea);
    const maxSimilarity = historyDocs.reduce((max, doc) => Math.max(max, textSimilarity(text, doc)), 0);
    const visualBoost = Array.isArray(idea.visualPotential) ? Math.min(0.08, idea.visualPotential.length * 0.02) : 0;
    const score = 1 - maxSimilarity + rareTopicBoost(text) + visualBoost;
    if (score > bestScore) {
      best = idea;
      bestScore = score;
    }
  }
  return best;
}

function normalizeStringList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 100))
    .filter(Boolean)
    .slice(0, limit);
}

function fallbackIdeas(input, reason = "") {
  const seed = input.seed || input.category;
  const rows = [
    {
      title: "Kenapa Kapal Besi Tidak Tenggelam",
      topic: "kapal besar bisa mengambang meski terbuat dari besi",
      hook: "Kapal sebesar gedung bisa mengapung, padahal bahannya besi. Kok bisa?",
      category: "sains",
      angle: "Mulai dari benda berat yang terlihat mustahil mengambang, lalu masuk ke prinsip daya apung.",
      visualPotential: ["kapal di laut", "air terdorong oleh lambung", "eksperimen gelas air"],
      whyGood: "Dekat dengan pengalaman sehari-hari dan visualnya jelas.",
      riskLevel: "rendah"
    },
    {
      title: "Rahasia Air Putih yang Sering Diremehkan",
      topic: "kenapa air putih penting untuk tubuh",
      hook: "Air putih kelihatannya biasa, tapi tubuh kita bekerja kacau kalau kekurangan ini.",
      category: "tubuh manusia",
      angle: "Jelaskan peran air tanpa klaim kesehatan berlebihan.",
      visualPotential: ["gelas air", "sel tubuh ilustratif", "aktivitas harian"],
      whyGood: "Topik universal dan mudah dipahami.",
      riskLevel: "rendah"
    },
    {
      title: "Emas Ternyata Lahir dari Ledakan Kosmik",
      topic: "asal-usul emas di alam semesta",
      hook: "Cincin emas yang kecil itu, asalnya bisa dari peristiwa raksasa di luar angkasa.",
      category: "alam semesta",
      angle: "Hubungkan benda sehari-hari dengan asal kosmik yang mengejutkan.",
      visualPotential: ["perhiasan emas", "bintang bertabrakan", "partikel kosmik"],
      whyGood: "Ada kontras besar antara benda kecil dan skala semesta.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Anak Kecil Akhirnya Bisa Berjalan",
      topic: "proses tubuh dan otak belajar berjalan",
      hook: "Langkah pertama anak kecil itu bukan sekadar kaki kuat. Otaknya juga sedang belajar besar-besaran.",
      category: "tubuh manusia",
      angle: "Buka dari momen familiar, lalu jelaskan koordinasi otak, otot, dan keseimbangan.",
      visualPotential: ["bayi belajar berdiri", "ilustrasi otak", "keseimbangan tubuh"],
      whyGood: "Emosional, dekat, dan edukatif.",
      riskLevel: "rendah"
    },
    {
      title: "Lampu Tidak Sesederhana Nama Satu Penemu",
      topic: "sejarah pengembangan lampu listrik",
      hook: "Kita sering dengar satu nama soal lampu, padahal ceritanya jauh lebih ramai.",
      category: "penemuan",
      angle: "Rapikan sejarah penemuan tanpa menjatuhkan satu tokoh.",
      visualPotential: ["lampu menyala", "laboratorium lama", "kota malam"],
      whyGood: "Meluruskan miskonsepsi populer.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Es Mengapung di Air",
      topic: "alasan es mengapung dan dampaknya untuk kehidupan",
      hook: "Kalau es tidak mengapung, kehidupan di Bumi bisa beda jauh.",
      category: "sains",
      angle: "Jelaskan kepadatan air dengan dampak besar pada alam.",
      visualPotential: ["es dalam gelas", "danau membeku", "molekul air"],
      whyGood: "Fenomena sederhana dengan konsekuensi besar.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Langit Bisa Berwarna Biru",
      topic: "hamburan cahaya yang membuat langit tampak biru",
      hook: "Langit biru bukan karena ada warna biru di atas sana.",
      category: "sains",
      angle: "Pakai analogi cahaya dan partikel udara.",
      visualPotential: ["langit cerah", "sinar matahari", "partikel udara"],
      whyGood: "Pertanyaan klasik yang tetap kuat untuk short.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Roda Koper Baru Terasa Normal Belakangan",
      topic: "sejarah sederhana roda pada koper",
      hook: "Aneh tapi nyata, koper beroda baru terasa umum setelah manusia lama sekali menyeret barang berat.",
      category: "benda sehari-hari",
      angle: "Bahas inovasi kecil yang terlambat jadi kebiasaan.",
      visualPotential: ["koper klasik", "bandara", "roda kecil close-up"],
      whyGood: "Unik, ringan, dan mudah dibuat visualnya.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Resleting Bisa Menutup dengan Rapi",
      topic: "cara kerja resleting dan kenapa giginya bisa mengunci",
      hook: "Resleting terlihat sepele, padahal ia mengatur puluhan gigi kecil seperti mesin yang sangat rapi.",
      category: "benda sehari-hari",
      angle: "Buka dari benda kecil yang dipakai tiap hari, lalu jelaskan desain slider dan gigi yang saling mengunci.",
      visualPotential: ["resleting makro", "gigi logam saling mengunci", "jaket dan tas"],
      whyGood: "Dekat, jarang dibahas, dan kuat untuk visual makro.",
      riskLevel: "rendah"
    },
    {
      title: "Kota Pernah Bau Sebelum Ada Pipa Modern",
      topic: "sejarah sanitasi kota dan lahirnya sistem pembuangan modern",
      hook: "Sebelum pipa modern, kota besar bisa punya masalah yang tidak kelihatan: bau, limbah, dan penyakit.",
      category: "sejarah",
      angle: "Hubungkan kenyamanan kota hari ini dengan revolusi infrastruktur yang jarang terlihat.",
      visualPotential: ["jalan kota lama", "pipa bawah tanah", "aliran air bersih"],
      whyGood: "Ada unsur sejarah, teknologi, dan dampak sehari-hari dalam satu cerita.",
      riskLevel: "rendah"
    }
  ];

  return rows.map((row) => ({
    id: createId("idea"),
    ...row,
    topic: seed && seed !== input.category ? `${row.topic} (${seed})` : row.topic,
    estimatedDurationSec: input.durationSec,
    whyGood: reason ? `${row.whyGood} Catatan: ${reason}` : row.whyGood
  }));
}

function normalizeSelectedIdea(value) {
  if (!value || typeof value !== "object") return null;
  const title = cleanText(value.title, 90);
  const topic = cleanText(value.topic || title, 220);
  const hook = cleanText(value.hook, 180);
  if (!title && !topic && !hook) return null;
  return {
    id: cleanText(value.id, 80),
    title,
    topic,
    hook,
    category: cleanText(value.category, 80),
    angle: cleanText(value.angle, 220),
    whyGood: cleanText(value.whyGood, 220)
  };
}

export async function createIdeaRecommendations(rawInput = {}, context = {}) {
  const input = normalizeIdeaInput(rawInput);
  const promptText = buildIdeaPrompt(input, context);
  let result;
  let source = "offline";

  if (config.openai.apiKey) {
    try {
      result = await requestIdeaJson(promptText);
      source = "openai";
    } catch (error) {
      result = { ideas: fallbackIdeas(input, error.message) };
    }
  } else {
    result = { ideas: fallbackIdeas(input, "OPENAI_API_KEY belum aktif.") };
  }

  return {
    source,
    generatedAt: nowIso(),
    input,
    ideas: normalizeIdeas(result?.ideas, input)
  };
}

export async function createKnowledgeDraft(rawInput, context = {}) {
  const input = normalizeInput(rawInput);
  const promptText = buildPrompt(input, context);
  let plan;
  let source = "offline";

  if (config.openai.apiKey) {
    try {
      plan = await requestKnowledgeJson(promptText);
      source = "openai";
    } catch (error) {
      plan = fallbackPlan(input, error.message);
    }
  } else {
    plan = fallbackPlan(input, "OPENAI_API_KEY belum aktif.");
  }

  const normalized = normalizePlan(plan, input);
  const narrationText = normalized.scenes.map((scene) => scene.narration).join(" ");
  const outputText = JSON.stringify(normalized);
  const cost = estimateTotalCost({
    promptText,
    outputText,
    sceneCount: normalized.scenes.length,
    imageSize: input.imageSize,
    imageQuality: input.imageQuality,
    narrationChars: narrationText.length,
    ttsProvider: input.ttsProvider,
    pricing: config.pricing
  });

  return {
    id: createId("tau"),
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
}

function normalizeInput(input) {
  const selectedIdea = normalizeSelectedIdea(input.selectedIdea || input.idea);
  const category = cleanText(input.category || "random", 80);
  const randomCategory = categories[Math.floor(Math.random() * categories.length)];
  const chosenCategory = selectedIdea?.category || (category === "random" ? randomCategory : category);
  const durationSec = clamp(Number(input.durationSec || 90), 45, 120);
  const sceneCount = clamp(Number(input.sceneCount || Math.round(durationSec / 12)), 5, 10);

  return {
    topic: cleanText(selectedIdea?.topic || input.topic || "Kapal bisa mengambang karena prinsip Archimedes", 260),
    category: chosenCategory,
    hookStyle: cleanText(selectedIdea?.hook || input.hookStyle || "", 180),
    selectedIdea,
    tone: cleanText(input.tone || "natural, penasaran, hangat, seperti konten pengetahuan yang enak didengar", 180),
    durationSec,
    sceneCount,
    ttsProvider: String(input.ttsProvider || "openai").toLowerCase() === "elevenlabs" ? "elevenlabs" : "openai",
    imageSize: cleanText(input.imageSize || config.openai.imageSize, 40),
    imageQuality: cleanText(input.imageQuality || config.openai.imageQuality, 20)
  };
}

function buildPrompt(input, context) {
  const recent = Array.isArray(context.existingItems)
    ? context.existingItems.slice(0, 90).map((item) => `- ${item.title}: ${item.plan?.hook || item.hook || item.input?.topic || item.topic || ""}`)
    : [];
  const idea = input.selectedIdea;

  return [
    "Buat naskah video vertikal channel pengetahuan Bahasa Indonesia bernama BanyakTau.",
    "Kontennya bergaya ensiklopedia ringan: ilmu, penemuan, sejarah, alam, tubuh manusia, teknologi, atau benda sehari-hari.",
    "Tujuan: penonton merasa 'oh ternyata begitu', bukan seperti kelas formal.",
    "Wajib faktual dan hati-hati. Jangan membuat klaim palsu, jangan menyebut angka spesifik jika tidak yakin, dan jangan memakai figur publik modern secara kontroversial.",
    "Bahasa harus natural, menyambung, dan enak dibacakan TTS. Jangan kaku seperti artikel Wikipedia. Jangan bertele-tele.",
    "Kamu yang membuat hook, judul, dan alur narasi. Jangan terasa seperti template.",
    "Topik harus terasa segar dibanding riwayat. Jika ada kemiripan dengan daftar riwayat, geser contoh, sudut pandang, dan mekanisme utama sampai berbeda.",
    "Judul harus siap pakai untuk YouTube Shorts: singkat, jelas, maksimal 70 karakter, tanpa slang pembuka seperti 'gimana sih', dan kuat dibaca di thumbnail.",
    "Awali dengan satu kalimat hook yang membuat orang berhenti scroll, lalu langsung masuk ke penjelasan.",
    idea ? "Pakai ide terpilih user sebagai sumber utama. Jangan mengganti topik atau angle utamanya." : "Jika user belum memilih ide, buat sendiri hook paling kuat dari topik yang tersedia.",
    idea ? `Ide terpilih:\n- Judul: ${idea.title}\n- Topik: ${idea.topic}\n- Hook: ${idea.hook}\n- Angle: ${idea.angle}\n- Alasan kuat: ${idea.whyGood}` : "",
    "Setelah hook, jelaskan isi video dengan alur: kejutan awal, penjelasan inti, analogi sederhana, bagian penting, lalu penutup yang membuat orang ingin tahu lebih banyak.",
    "Field summary wajib meringkas inti video, bukan CTA. Tulis 1-2 kalimat lengkap, 110-170 karakter, menyebut penyebab/proses utama dan alasan kenapa fakta ini penting diingat. Jangan membuat kalimat menggantung.",
    "Field importantPoints wajib berisi 3-5 fakta inti dari video. Jangan isi dengan instruksi produksi seperti mulai dari contoh, gunakan analogi, atau akhiri dengan fakta.",
    "Jangan membuat scene atau screenText berjudul Kesimpulan, Kesimpulan Singkat, atau Summary. Pakai penutup natural tanpa label kesimpulan.",
    "Tulis narasi scene sebagai satu cerita utuh yang dibagi untuk visual, bukan potongan-potongan yang terasa terpisah.",
    "Setiap scene harus punya visualPrompt berbeda: variasikan objek close-up, diagram konseptual tanpa teks, manusia belajar/mengamati, timeline, eksperimen sederhana, alam, arsip sejarah, atau visual makro.",
    "Jangan minta gambar berisi teks, logo, watermark, atau wajah tokoh nyata yang masih hidup.",
    "Kembalikan JSON valid saja dengan shape:",
    "{ title, hook, summary, importantPoints:[string], factCheckNote, scenes:[{ index, durationSec, narration, screenText, imagePrompt, visualStyle }] }",
    `Topik: ${input.topic}`,
    `Kategori: ${input.category}`,
    input.hookStyle ? `Hook yang harus dipakai atau dijadikan dasar: ${input.hookStyle}` : "",
    `Tone suara: ${input.tone}`,
    `Durasi maksimal: ${input.durationSec} detik`,
    `Jumlah scene: ${input.sceneCount}`,
    `Target total narasi: sekitar ${wordTarget(input.durationSec)} kata, jangan lebih dari itu.`,
    recent.length ? `Hindari duplikasi dari log/riwayat terbaru:\n${recent.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function historyText(item = {}) {
  return [
    item.title,
    item.topic,
    item.input?.topic,
    item.plan?.hook,
    item.hook,
    item.plan?.summary,
    item.summary,
    ...(item.plan?.importantPoints || item.importantPoints || [])
  ].filter(Boolean).join(" ");
}

function ideaText(idea = {}) {
  return [
    idea.title,
    idea.topic,
    idea.hook,
    idea.category,
    idea.angle,
    idea.whyGood,
    ...(idea.visualPotential || [])
  ].filter(Boolean).join(" ");
}

function textSimilarity(left, right) {
  const a = keywordSet(left);
  const b = keywordSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function keywordSet(value) {
  const stopwords = new Set([
    "yang", "dan", "atau", "dari", "untuk", "dengan", "karena", "kenapa", "bisa", "cara", "jadi",
    "ini", "itu", "dalam", "pada", "sebagai", "video", "fakta", "ternyata", "sering", "tidak",
    "bukan", "saat", "lebih", "kalau", "kita", "mereka", "sebuah", "satu", "hal"
  ]);
  return new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= 4 && !stopwords.has(token)));
}

function rareTopicBoost(value) {
  const text = String(value || "").toLowerCase();
  const rareSignals = [
    "resleting", "pipa", "sanitasi", "arsip", "kode", "material", "mikro", "bawah tanah",
    "kebiasaan", "kemasan", "instrumen", "peta", "warna", "bunyi", "bau", "tekstur"
  ];
  return rareSignals.some((signal) => text.includes(signal)) ? 0.08 : 0;
}

function wordTarget(durationSec) {
  return Math.round(clamp(durationSec, 45, 120) * 1.95);
}

function normalizePlan(plan, input) {
  const fallback = fallbackPlan(input);
  const rawScenes = Array.isArray(plan?.scenes) && plan.scenes.length ? plan.scenes : fallback.scenes;
  const durations = distributeDurations(input.durationSec, input.sceneCount);
  const scenes = rawScenes.slice(0, input.sceneCount).map((scene, index) => normalizeScene(scene, index, input, durations[index]));

  while (scenes.length < input.sceneCount) {
    const index = scenes.length;
    scenes.push(normalizeScene(fallback.scenes[index % fallback.scenes.length], index, input, durations[index]));
  }

  return {
    title: cleanPublicTitle(plan?.title || input.selectedIdea?.title || fallback.title),
    hook: cleanText(plan?.hook || input.selectedIdea?.hook || fallback.hook, 180),
    summary: normalizeSummary(plan?.summary, input, scenes, fallback.summary),
    importantPoints: normalizePoints(plan?.importantPoints || fallback.importantPoints),
    factCheckNote: cleanText(plan?.factCheckNote || "Disusun sebagai penjelasan populer; detail teknis dapat diperdalam lagi dari sumber ilmiah.", 220),
    scenes
  };
}

function cleanPublicTitle(value) {
  return titleCase(cleanText(value, 90)
    .replace(/\b(gimana|sih|kok|dong)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!]+$/g, ""));
}

function normalizeScene(scene, index, input, durationSec) {
  const screenText = cleanSceneText(scene?.screenText || sceneTitle(index, input));
  const narration = cleanText(scene?.narration || fallbackNarration(index, input), 520);
  return {
    index: index + 1,
    durationSec,
    narration,
    screenText,
    imagePrompt: enhanceImagePrompt(scene?.imagePrompt || `${screenText}. ${narration}`, input, index),
    visualStyle: cleanText(scene?.visualStyle || visualStyle(index), 120)
  };
}

function cleanSceneText(value) {
  const text = cleanText(value, 68)
    .replace(/\bKesimpulan\s+Singkat\b/gi, "Fakta Utama")
    .replace(/\bKesimpulan\b/gi, "Fakta Utama")
    .replace(/\bSummary\b/gi, "Fakta Utama")
    .trim();
  return text || "Fakta Utama";
}

function normalizePoints(points) {
  const normalized = (Array.isArray(points) ? points : [])
    .map((point) => cleanText(point, 140))
    .filter((point) => !isProductionInstruction(point))
    .filter(Boolean)
    .slice(0, 5);
  if (normalized.length) return normalized;
  return [
    "Hal yang terlihat sederhana sering punya mekanisme tersembunyi.",
    "Faktor kecil bisa saling bekerja sampai hasilnya terlihat alami.",
    "Memahami prosesnya membuat fakta sehari-hari terasa lebih masuk akal."
  ];
}

function normalizeSummary(value, input, scenes, fallback) {
  const text = cleanText(value, 480);
  if (text && !isProductionInstruction(text) && !/^draft fallback dibuat karena/i.test(text)) {
    return text;
  }

  const closingNarration = cleanText(scenes.at(-1)?.narration || "", 220);
  if (closingNarration && !isProductionInstruction(closingNarration)) {
    return cleanText(closingNarration, 320);
  }

  return cleanText(fallback || coreFallbackSummary(input), 320);
}

function isProductionInstruction(value) {
  return /\b(mulai dari|jelaskan|akhiri|gunakan analogi|contoh yang dekat|target total|storyboard|draft fallback)\b/i.test(String(value || ""));
}

function distributeDurations(total, count) {
  const safeCount = Math.max(1, count);
  const base = clamp(Number(total || 90), 45, 120) / safeCount;
  return Array.from({ length: safeCount }, (_, index) => {
    const emphasis = index === 0 ? 1.06 : index === safeCount - 1 ? 1.02 : 1;
    return Number((base * emphasis).toFixed(2));
  });
}

function enhanceImagePrompt(prompt, input, index) {
  const styles = [
    "clean macro detail shot",
    "cinematic everyday object demonstration",
    "museum archive inspired scene",
    "bright science explainer composition",
    "soft 3D cutaway style illustration",
    "natural documentary moment",
    "timeline-like scene without text",
    "conceptual diagram style without labels"
  ];
  return [
    cleanText(prompt, 700),
    `topic: ${input.topic}`,
    `visual approach: ${styles[index % styles.length]}`,
    "vertical 9:16, editorial science magazine look, bright readable lighting, rich but realistic colors, clear single subject, no written text, no logo, no watermark"
  ].join(", ");
}

function visualStyle(index) {
  return [
    "slow push-in, clean editorial title layer",
    "gentle pan, object callout feeling",
    "soft zoom-out, documentary mood",
    "light parallax, modern knowledge-card layout"
  ][index % 4];
}

function fallbackPlan(input, reason = "") {
  const title = titleCase((input.selectedIdea?.title || input.topic).replace(/[?.!]+$/g, ""));
  const hookBase = input.selectedIdea?.hook || input.hookStyle || `Ternyata ${input.topic.toLowerCase()} punya sisi yang jarang dibahas`;
  const hook = hookBase.toLowerCase().includes(input.topic.toLowerCase())
    ? hookBase
    : `${hookBase.replace(/[. ]+$/g, "")}: ${input.topic}`;
  const beats = [
    `${hook}. Kelihatannya sederhana, tapi di balik hal ini ada prinsip yang membuat dunia bekerja dengan cara yang rapi.`,
    `Intinya, ${input.topic.toLowerCase()} bisa dipahami kalau kita melihat hubungan antara bentuk, gaya, energi, dan waktu.`,
    "Bayangkan sebuah benda sehari-hari. Saat satu bagian berubah sedikit saja, hasil akhirnya bisa berbeda jauh dari yang kita kira.",
    "Bagian pentingnya adalah proses ini tidak berdiri sendiri. Ada banyak faktor kecil yang saling membantu sampai hasilnya terlihat alami.",
    "Jadi, hal yang sering kita anggap biasa sebenarnya menyimpan penjelasan yang cukup dalam, dan itu yang membuatnya menarik untuk dipelajari."
  ];
  return {
    title,
    hook,
    summary: coreFallbackSummary(input),
    importantPoints: [
      "Mulai dari contoh yang dekat dengan penonton.",
      "Ubah konsep rumit menjadi analogi sederhana.",
      "Akhiri dengan fakta yang mudah diingat."
    ],
    factCheckNote: reason
      ? `Fallback offline karena: ${reason}. Verifikasi sumber tambahan sebelum dipublikasikan.`
      : "Fallback offline; verifikasi sumber tambahan sebelum dipublikasikan.",
    scenes: Array.from({ length: input.sceneCount }, (_, index) => ({
      index: index + 1,
      durationSec: input.durationSec / input.sceneCount,
      narration: beats[index % beats.length],
      screenText: sceneTitle(index, input),
      imagePrompt: `${sceneTitle(index, input)}, educational visual about ${input.topic}, bright editorial illustration`,
      visualStyle: visualStyle(index)
    }))
  };
}

function coreFallbackSummary(input) {
  return cleanText(
    `Intinya, ${input.topic.toLowerCase()} menarik karena hal yang tampak sederhana biasanya terjadi dari beberapa faktor yang bekerja bersama. Saat bentuk, gaya, energi, dan waktu saling memengaruhi, hasil akhirnya bisa berbeda dari dugaan kita.`,
    320
  );
}

function fallbackNarration(index, input) {
  return fallbackPlan(input).scenes[index % 5].narration;
}

function sceneTitle(index, input) {
  return [
    "Fakta yang Jarang Dibahas",
    "Cara Kerjanya",
    "Contoh Sederhana",
    "Bagian Paling Penting",
    "Kenapa Ini Menarik",
    "Yang Sering Salah Dipahami",
    "Fakta Utama"
  ][index % 7] || input.category;
}

function titleCase(value) {
  return cleanText(value, 120)
    .split(" ")
    .map((word) => word.length > 3 ? `${word[0]?.toUpperCase() || ""}${word.slice(1)}` : word)
    .join(" ");
}
