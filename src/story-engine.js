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
  "tokoh dunia",
  "bahasa dan budaya",
  "makanan dan dapur",
  "material dan warna",
  "peta dan navigasi",
  "suara dan musik",
  "infrastruktur tersembunyi",
  "ekologi mikro"
];

const targetIdeaCount = 12;
const outputIdeaCount = 10;
const recentHistoryLimit = 180;
const genericSceneTexts = new Set([
  "fakta yang jarang dibahas",
  "cara kerjanya",
  "contoh sederhana",
  "bagian paling penting",
  "kenapa ini menarik",
  "yang sering salah dipahami",
  "fakta utama",
  "kesimpulan singkat",
  "summary"
]);

function normalizeIdeaInput(input, context = {}) {
  const category = cleanText(input.category || "random", 80);
  return {
    seed: cleanText(input.seed || input.topic || "", 260),
    category: category === "random" ? chooseFreshCategory(context.existingItems) : category,
    durationSec: clamp(Number(input.durationSec || 90), 45, 120)
  };
}

function buildIdeaPrompt(input, context) {
  const recent = Array.isArray(context.existingItems)
    ? context.existingItems.slice(0, 120).map(historyBrief)
    : [];
  const recentCategories = mostRecentCategories(context.existingItems, 10);
  const lockedSignals = recentTopicSignals(context.existingItems, 24);

  return [
    `Buat ${targetIdeaCount} rekomendasi ide video pendek untuk channel BanyakTau.`,
    `Channel ini berisi pengetahuan ringan lintas kategori: ${categories.join(", ")}.`,
    "Kamu yang menentukan hook dan judul; jangan beri template kosong dan jangan meminta user mengisi hook sendiri.",
    "Judul harus siap pakai untuk YouTube Shorts: singkat, jelas, maksimal 70 karakter, tanpa slang pembuka seperti 'gimana sih', 'mau tau', atau 'pernah nggak sih', dan kuat dibaca di thumbnail.",
    "Setiap ide harus punya rasa penasaran kuat, mudah divisualkan dengan gambar AI, dan bisa dijelaskan faktual dalam maksimal 2 menit.",
    "Pilih ide yang hemat produksi: cukup gambar AI + TTS. Jangan menyarankan cuplikan video AI, footage, b-roll video, atau proses yang butuh video generator.",
    "Prioritas ide: jarang dipilih channel edukasi umum, punya kontras kuat, dan terasa seperti penonton menemukan sisi tersembunyi dari benda, kebiasaan, tempat, bunyi, bahan, atau fenomena yang spesifik.",
    "Setiap ide wajib benar-benar berbeda dari riwayat. Jangan ulang judul, objek utama, tempat utama, mekanisme penjelasan, analogi inti, atau hook yang mirip dengan daftar riwayat.",
    "Jika riwayat berisi sains dasar, piramida, kapal, komputer memahami bahasa, atau memori otak, geser jauh ke sejarah benda, infrastruktur tersembunyi, asal-usul kebiasaan, material, peta, suara, makanan, atau ekologi mikro.",
    "Jangan pakai topik yang terlalu luas seperti 'teknologi', 'sejarah', atau 'tubuh manusia' sebagai topic. Topic harus menunjuk objek/fenomena spesifik.",
    "Sebarkan kandidat ke beberapa kategori berbeda. Jangan membuat 2 ide dengan objek utama, tempat, atau mekanisme yang sama.",
    "Jangan pilih klaim medis/keuangan/hukum yang berisiko, teori konspirasi, atau topik yang butuh wajah figur publik modern.",
    "Bahasa hook harus natural seperti kreator Indonesia, bukan judul artikel kaku. Hindari kata yang terlalu lebay seperti ajaib, tergila-gila, dan klaim bombastis tanpa dasar.",
    "Kembalikan JSON valid saja dengan shape:",
    "{ ideas:[{ title, topic, hook, category, angle, whyGood, visualPotential:[string], riskLevel, estimatedDurationSec }] }",
    input.seed ? `Arah topik dari user: ${input.seed}` : "Arah topik dari user: bebas, cari ide paling menarik.",
    `Kategori prioritas: ${input.category}`,
    `Durasi target: ${input.durationSec} detik`,
    recentCategories.length ? `Kategori yang baru dipakai, jangan dominan lagi: ${recentCategories.join(", ")}` : "",
    lockedSignals.length ? `Objek/mekanisme/tema yang dikunci agar tidak diulang: ${lockedSignals.join(", ")}` : "",
    recent.length ? `Riwayat/log yang wajib dihindari:\n${recent.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function normalizeIdeas(ideas, input, context = {}) {
  const rows = [
    ...(Array.isArray(ideas) && ideas.length ? ideas : []),
    ...fallbackIdeas(input, "", context)
  ];
  const seen = new Set();
  const normalized = [];
  const historyItems = Array.isArray(context.existingItems) ? context.existingItems : [];

  for (const idea of rows) {
    const title = cleanPublicTitle(idea?.title || idea?.topic || input.seed || "Fakta yang Jarang Dibahas");
    const hook = cleanText(idea?.hook || `Ternyata ${title.toLowerCase()} punya cerita yang jarang dibahas.`, 180);
    const topic = cleanText(idea?.topic || title, 220);
    if (isTooBroadTopic(topic, input.category)) continue;
    const key = canonicalIdeaKey({ title, topic, hook });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: createId("idea"),
      title,
      topic,
      hook,
      category: cleanText(idea?.category || input.category, 80),
      angle: cleanText(idea?.angle || "Dibuka dari rasa penasaran, lalu dijelaskan dengan analogi sederhana.", 220),
      whyGood: cleanText(idea?.whyGood || "Topik dekat dengan penonton dan mudah divisualkan.", 220),
      visualPotential: normalizeStringList(idea?.visualPotential, 4),
      riskLevel: cleanText(idea?.riskLevel || "rendah", 40),
      estimatedDurationSec: clamp(Number(idea?.estimatedDurationSec || input.durationSec), 45, 120)
    });
  }

  const ranked = rankIdeasByNovelty(normalized, historyItems);
  const result = [];
  const usedFamilies = new Set();
  for (const idea of ranked) {
    const family = ideaFamily(idea);
    if (usedFamilies.has(family)) continue;
    usedFamilies.add(family);
    result.push(idea);
    if (result.length >= outputIdeaCount) break;
  }

  for (const fallback of fallbackIdeas(input, "", context)) {
    if (result.length >= outputIdeaCount) break;
    const family = ideaFamily(fallback);
    if (usedFamilies.has(family)) continue;
    usedFamilies.add(family);
    result.push({ ...fallback, id: createId("idea") });
  }

  return result.slice(0, outputIdeaCount);
}

export function selectMostNovelIdea(ideas = [], existingItems = []) {
  const candidates = Array.isArray(ideas) ? ideas.filter(Boolean) : [];
  if (!candidates.length) return null;
  return rankIdeasByNovelty(candidates, existingItems)[0] || candidates[0];
}

function chooseFreshCategory(existingItems = []) {
  const recent = (Array.isArray(existingItems) ? existingItems : [])
    .slice(0, 12)
    .map((item) => normalizeCategory(item.input?.category || item.category))
    .filter(Boolean);
  const recentSet = new Set(recent.slice(0, 4));
  const counts = new Map();
  for (const category of recent) counts.set(category, (counts.get(category) || 0) + 1);

  const candidates = categories
    .filter((category) => !recentSet.has(normalizeCategory(category)))
    .sort((left, right) => (counts.get(normalizeCategory(left)) || 0) - (counts.get(normalizeCategory(right)) || 0));

  const pool = candidates.length ? candidates.slice(0, Math.min(5, candidates.length)) : categories;
  return pool[Math.floor(Math.random() * pool.length)] || "benda sehari-hari";
}

function mostRecentCategories(existingItems = [], limit = 8) {
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(existingItems) ? existingItems.slice(0, limit) : []) {
    const category = cleanText(item.input?.category || item.category || "", 80);
    const key = normalizeCategory(category);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(category);
  }
  return rows;
}

function recentTopicSignals(existingItems = [], limit = 18) {
  const seen = new Set();
  const signals = [];
  for (const item of Array.isArray(existingItems) ? existingItems.slice(0, limit) : []) {
    const tokens = [...keywordSet(historyText(item))]
      .filter((token) => token.length >= 5 && !genericTopicTokens().has(token))
      .slice(0, 5);
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      signals.push(token);
      if (signals.length >= limit) return signals;
    }
  }
  return signals;
}

function historyBrief(item = {}) {
  const title = item.title || item.plan?.title || "Tanpa judul";
  const topic = item.input?.topic || item.topic || "";
  const hook = item.plan?.hook || item.hook || "";
  const category = item.input?.category || item.category || "";
  return `- ${title}${topic ? ` | topik: ${topic}` : ""}${category ? ` | kategori: ${category}` : ""}${hook ? ` | hook: ${hook}` : ""}`;
}

function rankIdeasByNovelty(ideas = [], existingItems = []) {
  const historyItems = Array.isArray(existingItems) ? existingItems : [];
  const historyDocs = historyItems
    .slice(0, recentHistoryLimit)
    .map(historyText)
    .filter(Boolean);
  const recentCategories = historyItems
    .slice(0, 8)
    .map((item) => normalizeCategory(item.input?.category || item.category))
    .filter(Boolean);
  const exactHistoryKeys = new Set(historyItems.map((item) => canonicalIdeaKey({
    title: item.title || item.plan?.title,
    topic: item.input?.topic || item.topic,
    hook: item.plan?.hook || item.hook
  })));

  return [...ideas]
    .map((idea, order) => {
      const text = ideaText(idea);
      const tokens = keywordSet(text);
      const maxSimilarity = historyDocs.reduce((max, doc) => Math.max(max, textSimilarity(text, doc)), 0);
      const categoryPenalty = recentCategories.includes(normalizeCategory(idea.category)) ? 0.14 : 0;
      const exactPenalty = exactHistoryKeys.has(canonicalIdeaKey(idea)) ? 0.55 : 0;
      const genericPenalty = isTooBroadTopic(idea.topic, idea.category) ? 0.35 : 0;
      const repeatedObjectPenalty = repeatedObjectScore(tokens, historyItems);
      const visualBoost = Array.isArray(idea.visualPotential) ? Math.min(0.08, idea.visualPotential.length * 0.02) : 0;
      const specificityBoost = Math.min(0.12, tokens.size * 0.006);
      const score = 1
        - maxSimilarity
        - categoryPenalty
        - exactPenalty
        - genericPenalty
        - repeatedObjectPenalty
        + rareTopicBoost(text)
        + visualBoost
        + specificityBoost
        - order * 0.001;
      return { idea, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.idea);
}

function repeatedObjectScore(tokens, historyItems = []) {
  if (!tokens.size) return 0;
  let penalty = 0;
  for (const item of historyItems.slice(0, 16)) {
    const historyTokens = keywordSet(historyText(item));
    let overlap = 0;
    for (const token of tokens) {
      if (!genericTopicTokens().has(token) && historyTokens.has(token)) overlap += 1;
    }
    if (overlap >= 3) penalty = Math.max(penalty, 0.22);
    else if (overlap >= 2) penalty = Math.max(penalty, 0.12);
  }
  return penalty;
}

function canonicalIdeaKey(idea = {}) {
  return cleanText([idea.title, idea.topic, idea.hook].filter(Boolean).join(" "), 420)
    .toLowerCase()
    .replace(/\b(mau|tau|tahu|kenapa|cara|rahasia|ternyata|fakta|yang|bisa|ini|itu|dan|di|ke|dari|untuk)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ideaFamily(idea = {}) {
  const tokens = [...keywordSet(ideaText(idea))]
    .filter((token) => !genericTopicTokens().has(token))
    .slice(0, 3);
  return tokens.join("|") || canonicalIdeaKey(idea).slice(0, 36);
}

function isTooBroadTopic(topic, category) {
  const text = cleanText(topic || "", 120).toLowerCase();
  const categoryText = cleanText(category || "", 120).toLowerCase();
  if (!text) return true;
  if (text === categoryText) return true;
  if (categories.map(normalizeCategory).includes(normalizeCategory(text))) return true;
  return text.split(/\s+/).filter(Boolean).length <= 1 && text.length < 12;
}

function normalizeCategory(value) {
  return cleanText(value || "", 80).toLowerCase().replace(/\s+/g, " ");
}

function normalizeStringList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 100))
    .filter(Boolean)
    .slice(0, limit);
}

function fallbackIdeas(input, reason = "", context = {}) {
  const requestedCategory = normalizeCategory(input.category);
  const rows = ideaBank()
    .filter((row) => !requestedCategory || requestedCategory === "random" || normalizeCategory(row.category) === requestedCategory)
    .concat(ideaBank().filter((row) => normalizeCategory(row.category) !== requestedCategory));
  const ranked = rankIdeasByNovelty(rows, context.existingItems || []);
  const seed = cleanText(input.seed || "", 160);
  const seededRows = seed ? seededFallbackIdeas(seed, input) : [];
  const combined = [...seededRows, ...ranked];
  const seen = new Set();
  return combined
    .filter((row) => {
      const key = canonicalIdeaKey(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, targetIdeaCount)
    .map((row) => ({
      id: createId("idea"),
      ...row,
      estimatedDurationSec: input.durationSec,
      whyGood: reason ? `${row.whyGood} Catatan: ${reason}` : row.whyGood
    }));
}

function seededFallbackIdeas(seed, input) {
  const category = input.category || "benda sehari-hari";
  return [
    {
      title: cleanPublicTitle(`Sisi Tersembunyi ${seed}`),
      topic: `sisi teknis dan sejarah kecil di balik ${seed}`,
      hook: `${seed} kelihatannya biasa, tapi ada detail kecil yang sering luput dari perhatian.`,
      category,
      angle: "Mulai dari satu detail spesifik, lalu bongkar asal-usul atau mekanisme yang tidak umum dibahas.",
      visualPotential: ["close-up objek utama", "arsip atau meja kerja", "diagram tanpa teks"],
      whyGood: "Tetap mengikuti seed user, tapi dipaksa masuk ke angle yang lebih spesifik.",
      riskLevel: "rendah"
    }
  ];
}

function ideaBank() {
  return [
    {
      title: "Kenapa Tutup Botol Punya Cincin Kecil",
      topic: "fungsi cincin segel pada tutup botol plastik",
      hook: "Cincin kecil di tutup botol bukan hiasan. Ia dibuat untuk memberi tahu sesuatu sebelum kamu minum.",
      category: "benda sehari-hari",
      angle: "Buka dari bunyi klik tutup botol, lalu jelaskan segel, keamanan produk, dan desain murah yang efektif.",
      visualPotential: ["tutup botol makro", "cincin segel patah", "meja produksi minuman"],
      whyGood: "Objeknya sangat dekat, spesifik, dan jarang dijadikan cerita utama.",
      riskLevel: "rendah"
    },
    {
      title: "Jalan Aspal Bisa Panas Karena Warna",
      topic: "kenapa aspal menyerap panas lebih banyak dari permukaan terang",
      hook: "Jalan yang hitam bisa terasa seperti kompor kecil karena cara warna menyerap cahaya.",
      category: "material dan warna",
      angle: "Hubungkan warna gelap, serapan energi, dan efek pulau panas kota tanpa klaim berlebihan.",
      visualPotential: ["aspal siang hari", "termometer permukaan", "perbandingan ubin terang"],
      whyGood: "Visual kuat dan terasa relevan di kota tropis.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Lift Punya Cermin",
      topic: "alasan psikologis dan aksesibilitas cermin di lift",
      hook: "Cermin di lift bukan cuma buat merapikan rambut. Ada alasan desain yang lebih praktis.",
      category: "infrastruktur tersembunyi",
      angle: "Bahas persepsi waktu tunggu, rasa ruang, dan bantuan manuver pengguna kursi roda.",
      visualPotential: ["interior lift", "pantulan cermin", "lobi gedung"],
      whyGood: "Topik ringan, urban, dan punya twist desain yang tidak repetitif.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Kerupuk Bisa Mengembang",
      topic: "uap air dan pati yang membuat kerupuk mekar saat digoreng",
      hook: "Kerupuk yang tipis bisa mekar besar karena air kecil di dalamnya berubah jadi tenaga.",
      category: "makanan dan dapur",
      angle: "Jelaskan pati, kadar air, dan panas minyak dengan analogi sederhana.",
      visualPotential: ["kerupuk sebelum digoreng", "minyak panas", "gelembung uap"],
      whyGood: "Dekat dengan penonton Indonesia dan mudah divisualkan tanpa video footage.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Peta Utara Selalu di Atas",
      topic: "sejarah konvensi utara di bagian atas peta modern",
      hook: "Utara di atas peta terasa alami, padahal itu hasil kebiasaan sejarah, bukan aturan alam.",
      category: "peta dan navigasi",
      angle: "Bahas konvensi kartografi, kompas, dan bagaimana peta membentuk cara kita membayangkan dunia.",
      visualPotential: ["peta tua", "kompas di meja", "globe diputar"],
      whyGood: "Membalik asumsi sehari-hari dengan sejarah visual yang kaya.",
      riskLevel: "rendah"
    },
    {
      title: "Suara Sirene Dibuat Naik Turun",
      topic: "kenapa sirene darurat memakai pola nada naik turun",
      hook: "Sirene tidak dibuat asal keras. Pola naik turunnya membantu otak menangkap bahaya lebih cepat.",
      category: "suara dan musik",
      angle: "Jelaskan perhatian manusia, frekuensi berubah, dan bedanya suara peringatan dengan suara biasa.",
      visualPotential: ["gelombang suara", "lampu darurat abstrak", "jalan kota malam"],
      whyGood: "Tidak mengulang sains klasik, tetap faktual, dan audio-visualnya kuat.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Kertas Struk Cepat Pudar",
      topic: "cara kerja kertas thermal pada struk belanja",
      hook: "Tulisan di struk bisa hilang karena sebenarnya ia muncul dari reaksi panas, bukan tinta biasa.",
      category: "benda sehari-hari",
      angle: "Buka dari struk pudar, lalu jelaskan lapisan thermal, panas, cahaya, dan penyimpanan.",
      visualPotential: ["struk belanja makro", "printer kasir", "lapisan kertas konseptual"],
      whyGood: "Benda sangat umum dengan mekanisme tersembunyi.",
      riskLevel: "rendah"
    },
    {
      title: "Jam Pasir Mengukur Waktu Lewat Kemacetan",
      topic: "aliran butiran pasir dan leher sempit pada jam pasir",
      hook: "Jam pasir bekerja bukan karena pasirnya istimewa, tapi karena ada kemacetan kecil yang stabil.",
      category: "benda sehari-hari",
      angle: "Jelaskan aliran granular, ukuran lubang, dan kenapa butiran tidak jatuh sekaligus.",
      visualPotential: ["jam pasir makro", "butiran pasir", "leher kaca sempit"],
      whyGood: "Mekanisme unik, mudah dibuat visual, dan jauh dari topik lama.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Garam Bikin Es Lebih Dingin",
      topic: "garam menurunkan titik beku air pada es",
      hook: "Garam bisa membuat es terasa lebih dingin karena ia mengacaukan cara air membeku.",
      category: "sains",
      angle: "Pakai eksperimen dapur sederhana tanpa klaim medis, cocok untuk visual es dan garam.",
      visualPotential: ["es batu dan garam", "mangkuk dapur", "kristal es makro"],
      whyGood: "Sains sederhana tapi angle-nya praktis dan tidak memakai kapal atau langit.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Nama Jalan Sering Berubah",
      topic: "sejarah penamaan ulang jalan sebagai memori kota",
      hook: "Nama jalan bukan sekadar penunjuk arah. Kadang ia adalah cara kota mengingat sesuatu.",
      category: "bahasa dan budaya",
      angle: "Hubungkan papan jalan, sejarah lokal, perubahan politik, dan memori publik secara netral.",
      visualPotential: ["papan nama jalan", "arsip kota", "peta lingkungan"],
      whyGood: "Beda dari sains umum dan bisa dibuat relevan untuk penonton Indonesia.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Stainless Steel Tidak Mudah Berkarat",
      topic: "lapisan pasif kromium pada stainless steel",
      hook: "Stainless steel tahan karat karena punya pelindung tipis yang terbentuk sendiri.",
      category: "material dan warna",
      angle: "Jelaskan lapisan oksida kromium dengan contoh sendok, wastafel, dan alat dapur.",
      visualPotential: ["sendok stainless makro", "lapisan pelindung konseptual", "dapur bersih"],
      whyGood: "Material sehari-hari, detailnya spesifik, dan aman secara faktual.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Terowongan Kereta Punya Angin Kencang",
      topic: "efek piston udara saat kereta masuk terowongan",
      hook: "Saat kereta masuk terowongan, udara di depannya seperti terdorong piston raksasa.",
      category: "infrastruktur tersembunyi",
      angle: "Bahas tekanan udara, ruang sempit, dan desain ventilasi transportasi.",
      visualPotential: ["terowongan kereta", "aliran udara konseptual", "peron bawah tanah"],
      whyGood: "Infrastruktur terasa dekat dan punya mekanisme dramatis tanpa video AI.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Buku Lama Punya Bau Khas",
      topic: "senyawa volatil dari kertas tua yang memberi aroma buku lama",
      hook: "Bau buku lama bukan cuma nostalgia. Kertasnya benar-benar melepas jejak kimia kecil.",
      category: "material dan warna",
      angle: "Jelaskan penuaan kertas, lignin, dan aroma tanpa membuat klaim kesehatan.",
      visualPotential: ["buku tua makro", "rak perpustakaan", "partikel aroma konseptual"],
      whyGood: "Puitis tapi faktual, visualnya kuat, dan jauh dari topik lama.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Cabai Terasa Panas Padahal Tidak Membakar",
      topic: "capsaicin menipu reseptor panas di mulut",
      hook: "Cabai terasa panas bukan karena suhunya tinggi, tapi karena mulut kita menerima sinyal palsu.",
      category: "makanan dan dapur",
      angle: "Jelaskan capsaicin dan reseptor rasa pedas dengan analogi alarm tubuh.",
      visualPotential: ["cabai merah makro", "mulut ilustratif aman", "mangkuk sambal"],
      whyGood: "Topik Indonesia, mudah dipahami, dan berbeda dari memori/kapal/piramida.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Kompas Bisa Bingung di Dekat Magnet",
      topic: "gangguan medan magnet pada jarum kompas",
      hook: "Kompas terlihat yakin menunjuk utara, sampai ada magnet kecil yang mengubah seluruh ceritanya.",
      category: "peta dan navigasi",
      angle: "Bahas medan magnet bumi dengan demonstrasi meja yang aman.",
      visualPotential: ["kompas close-up", "magnet kecil", "garis medan konseptual"],
      whyGood: "Navigasi klasik tapi objeknya spesifik dan tidak mengulang topik teknologi bahasa.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Jam Digital Butuh Kristal Kecil",
      topic: "kristal kuarsa sebagai penjaga waktu pada jam digital",
      hook: "Di dalam jam digital ada kristal kecil yang bergetar sangat teratur untuk menjaga waktu.",
      category: "teknologi",
      angle: "Jelaskan osilasi kuarsa, rangkaian sederhana, dan kenapa getaran bisa jadi detik.",
      visualPotential: ["jam digital dibuka", "kristal kuarsa makro", "gelombang getaran"],
      whyGood: "Teknologi spesifik, bukan komputer memahami bahasa.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Lumut Suka Muncul di Tembok Lembap",
      topic: "spora lumut, kelembapan, dan permukaan berpori",
      hook: "Lumut di tembok bukan muncul tiba-tiba. Ia menunggu kombinasi lembap, cahaya, dan permukaan yang pas.",
      category: "ekologi mikro",
      angle: "Hubungkan spora, air, dan material bangunan dengan visual makro.",
      visualPotential: ["tembok lembap makro", "spora konseptual", "tetes air di permukaan"],
      whyGood: "Dekat dengan rumah tropis dan memberi variasi ekologi kecil.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Kalender Punya Bulan Tidak Sama Panjang",
      topic: "sejarah panjang bulan dalam kalender Gregorian",
      hook: "Jumlah hari tiap bulan tidak rapi karena kalender adalah hasil kompromi sejarah panjang.",
      category: "sejarah",
      angle: "Bahas kalender Romawi dan penyesuaian waktu secara ringkas tanpa detail kontroversial.",
      visualPotential: ["kalender meja", "bulan-bulan tersusun", "arsip angka Romawi"],
      whyGood: "Sejarah sehari-hari yang tidak kembali ke piramida.",
      riskLevel: "rendah"
    },
    {
      title: "Kenapa Sedotan Bisa Mengangkat Minuman",
      topic: "tekanan udara yang mendorong cairan naik di sedotan",
      hook: "Saat kamu menyedot minuman, sebenarnya udara luar ikut bekerja mendorong cairan naik.",
      category: "sains",
      angle: "Jelaskan tekanan udara dengan gelas dan sedotan, bukan gaya hisap yang sering disalahpahami.",
      visualPotential: ["sedotan dalam gelas", "panah tekanan tanpa teks", "meja kafe"],
      whyGood: "Sains dekat dan mekanismenya berbeda dari daya apung kapal.",
      riskLevel: "rendah"
    }
  ];
}

function normalizeSelectedIdea(value) {
  if (!value || typeof value !== "object") return null;
  const title = cleanPublicTitle(value.title);
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
  const input = normalizeIdeaInput(rawInput, context);
  const promptText = buildIdeaPrompt(input, context);
  let result;
  let source = "offline";

  if (config.openai.apiKey) {
    try {
      result = await requestIdeaJson(promptText);
      source = "openai";
    } catch (error) {
      result = { ideas: fallbackIdeas(input, error.message, context) };
    }
  } else {
    result = { ideas: fallbackIdeas(input, "OPENAI_API_KEY belum aktif.", context) };
  }

  return {
    source,
    generatedAt: nowIso(),
    input,
    ideas: normalizeIdeas(result?.ideas, input, context)
  };
}

export async function createKnowledgeDraft(rawInput, context = {}) {
  const input = normalizeInput(rawInput, context);
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
      carousels: [],
      clips: [],
      audio: null,
      video: null
    },
    cost
  };
}

function normalizeInput(input, context = {}) {
  const selectedIdea = normalizeSelectedIdea(input.selectedIdea || input.idea);
  const category = cleanText(input.category || "random", 80);
  const chosenCategory = selectedIdea?.category || (category === "random" ? chooseFreshCategory(context.existingItems) : category);
  const durationSec = clamp(Number(input.durationSec || 90), 45, 120);
  const sceneCount = clamp(Number(input.sceneCount || Math.round(durationSec / 12)), 5, 10);

  return {
    topic: cleanText(selectedIdea?.topic || input.topic || "fungsi cincin segel pada tutup botol plastik", 260),
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
    ? context.existingItems.slice(0, 120).map(historyBrief)
    : [];
  const idea = input.selectedIdea;
  const lockedSignals = recentTopicSignals(context.existingItems, 24);

  return [
    "Buat naskah video vertikal channel pengetahuan Bahasa Indonesia bernama BanyakTau.",
    `Kontennya bergaya ensiklopedia ringan lintas kategori: ${categories.join(", ")}.`,
    "Tujuan: penonton merasa 'oh ternyata begitu', bukan seperti kelas formal.",
    "Wajib faktual dan hati-hati. Jangan membuat klaim palsu, jangan menyebut angka spesifik jika tidak yakin, dan jangan memakai figur publik modern secara kontroversial.",
    "Bahasa harus natural, menyambung, dan enak dibacakan TTS. Jangan kaku seperti artikel Wikipedia. Jangan bertele-tele.",
    "Kamu yang membuat hook, judul, dan alur narasi. Jangan terasa seperti template.",
    "Topik harus terasa segar dibanding riwayat. Jika ada kemiripan dengan daftar riwayat, geser contoh, sudut pandang, dan mekanisme utama sampai berbeda.",
    "Judul harus siap pakai untuk YouTube Shorts: singkat, jelas, maksimal 70 karakter, tanpa slang pembuka seperti 'gimana sih', 'mau tau', atau 'pernah nggak sih', dan kuat dibaca di thumbnail.",
    "Awali dengan satu kalimat hook yang membuat orang berhenti scroll, lalu langsung masuk ke penjelasan.",
    "Dilarang memakai struktur scene generik seperti 'Fakta yang Jarang Dibahas', 'Cara Kerjanya', 'Contoh Sederhana', atau 'Kesimpulan Singkat'. Setiap screenText harus menyebut objek/proses spesifik.",
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
    lockedSignals.length ? `Objek/mekanisme/tema dari riwayat yang jangan diulang: ${lockedSignals.join(", ")}` : "",
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
    "bukan", "saat", "lebih", "kalau", "kita", "mereka", "sebuah", "satu", "hal", "mau",
    "tahu", "tau", "gimana", "pernah", "banget", "banyak", "dibahas", "rahasia"
  ]);
  return new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= 4 && !stopwords.has(token)));
}

function genericTopicTokens() {
  return new Set([
    "fakta", "rahasia", "dibahas", "banyak", "video", "penonton", "sehari", "hari",
    "mekanisme", "tersembunyi", "bagian", "penting", "contoh", "sederhana", "proses",
    "kategori", "visual", "natural", "hook", "angle", "topik", "bahasa", "dunia"
  ]);
}

function rareTopicBoost(value) {
  const text = String(value || "").toLowerCase();
  const rareSignals = [
    "resleting", "pipa", "sanitasi", "arsip", "kode", "material", "mikro", "bawah tanah",
    "kebiasaan", "kemasan", "instrumen", "peta", "warna", "bunyi", "bau", "tekstur",
    "lift", "struk", "thermal", "kuarsa", "kompas", "sirene", "kerupuk", "kalender",
    "terowongan", "lignin", "stainless", "lumut", "aspal", "sedotan"
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
    .replace(/\bmau\s+(tau|tahu)\b/gi, "")
    .replace(/\bpernah\s+(nggak|gak)\s+sih\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!]+$/g, ""));
}

function normalizeScene(scene, index, input, durationSec) {
  const screenText = cleanSceneText(scene?.screenText || sceneTitle(index, input), index, input);
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

function cleanSceneText(value, index = 0, input = {}) {
  const raw = cleanText(value, 68);
  const text = raw
    .replace(/\bKesimpulan\s+Singkat\b/gi, "Fakta Utama")
    .replace(/\bKesimpulan\b/gi, "Fakta Utama")
    .replace(/\bSummary\b/gi, "Fakta Utama")
    .trim();
  if (!text || genericSceneTexts.has(text.toLowerCase())) return sceneTitle(index, input);
  return text;
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
  const subject = compactSubject(input.selectedIdea?.title || input.topic || input.category || "Fakta");
  return [
    `${subject}: Detail Awal`,
    "Mekanisme Tersembunyi",
    "Bukti di Benda Sehari-hari",
    "Bagian yang Sering Luput",
    "Dampaknya Terasa Dekat",
    "Miskonsepsi yang Perlu Diluruskan",
    "Inti yang Perlu Diingat"
  ][index % 7] || subject;
}

function titleCase(value) {
  return cleanText(value, 120)
    .split(" ")
    .map((word) => word.length > 3 ? `${word[0]?.toUpperCase() || ""}${word.slice(1)}` : word)
    .join(" ");
}

function compactSubject(value) {
  const cleaned = cleanPublicTitle(value)
    .replace(/\b(kenapa|rahasia|fungsi|alasan|sisi|tersembunyi)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 4);
  return words.join(" ") || "Fakta Utama";
}
