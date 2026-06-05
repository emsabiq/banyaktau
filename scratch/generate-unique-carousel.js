import { renderCarouselSlide } from "../src/carousel-concept.js";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

// Unique, high-curiosity item draft about Infantile Amnesia
const item = {
  id: "carousel_amnesia_bayi",
  title: "Misteri Amnesia Bayi",
  input: { topic: "kenapa kita lupa memori saat bayi" },
  plan: {
    hook: "Kenapa tidak ada satu pun manusia yang ingat memori di bawah usia 3 tahun?",
    summary: "Otak bayi tumbuh sangat cepat sehingga koneksi memori lama diformat ulang demi sel baru.",
    scenes: []
  }
};

const carouselPlan = {
  title: "Misteri Amnesia Bayi",
  slideCount: 6,
  slides: [
    {
      index: 1,
      type: "title",
      titleText: "MISTERI AMNESIA BAYI"
    },
    {
      index: 2,
      type: "content",
      titleText: "MISTERI MEMORI YANG HILANG",
      bodyText: "KENAPA KITA TIDAK BISA MENGINGAT APA PUN YANG TERJADI SEBELUM USIA TIGA TAHUN? SEMUA ORANG MENGALAMINYA."
    },
    {
      index: 3,
      type: "content",
      titleText: "OTAK BAYI TUMBUH TERLALU CEPAT",
      bodyText: "HIPOKAMPUS SEBAGAI PUSAT MEMORI OTAK MANUSIA MEMPRODUKSI SEL SARAF BARU SECARA BESAR-BESARAN PADA TAHUN-TAHUN AWAL KEHIDUPAN KITA. PROSES PERTUMBUHAN NEURON BARU INI SANGAT CEPAT DAN DISEBUT SEBAGAI NEUROGENESIS, YANG MANA PADA AKHIRNYA AKAN MENGGANTIKAN ATAU MENIMPA STRUKTUR JARINGAN KONEKSI LAMA SEHINGGA SEMUA MEMORI AWAL MASA KECIL KITA SEOLAH-OLAH DI-FORMAT ULANG HINGGA BERSIH TANPA BEKAS."
    },
    {
      index: 4,
      type: "content",
      titleText: "SEL BARU YANG SANGAT BANYAK INI MENGHAPUS DATA LAMA",
      bodyText: "PERTUMBUHAN SEL BARU YANG SANGAT CEPAT INI MEMUTUSKAN KONEKSI MEMORI SEBELUMNYA DAN MENIMPA DATA LAMA."
    },
    {
      index: 5,
      type: "content",
      titleText: "PERKEMBANGAN BAHASA DAN DIRI",
      bodyText: "MEMORI MEMBUTUHKAN KONSEP DIRI DAN BAHASA UNTUK DISIMPAN JANGKA PANJANG. BAYI BELUM MEMILIKI KEDUANYA."
    },
    {
      index: 6,
      type: "content",
      titleText: "MISTERI AMNESIA INFANTIL",
      bodyText: "JADI, BUKAN KARENA MEMORINYA HILANG, TAPI KARENA ALAT PENYIMPANAN DI OTAK KITA SEDANG DI-FORMAT ULANG."
    }
  ]
};

async function main() {
  await fs.mkdir(path.join("public", "amnesia"), { recursive: true });
  console.log("Generating unique carousel slides...");

  // Use Colosseum scene images as fallback backgrounds for this demo
  const bg1 = path.resolve("generated", "images", "carousel-demo-scene-1-kenapa-segel-botol-plastik-penting.jpg");
  const bg2 = path.resolve("generated", "images", "carousel-demo-scene-2-apa-fungsi-segel-botol.jpg");
  const bg3 = path.resolve("generated", "images", "carousel-demo-scene-3-bagaimana-segel-membantu-keamanan.jpg");

  const bgPaths = [bg1, bg2, bg3, bg1, bg2, bg3];

  for (let i = 0; i < carouselPlan.slides.length; i++) {
    const slide = carouselPlan.slides[i];
    const bgPath = bgPaths[i] || bg1;
    console.log(`Rendering Slide ${slide.index}...`);
    const result = await renderCarouselSlide({
      item,
      carousel: carouselPlan,
      slide,
      backgroundPath: bgPath
    });
    const dest = path.join("public", "amnesia", `slide-${slide.index}.jpg`);
    await fs.copyFile(result.path, dest);
    console.log(`Saved Slide ${slide.index} to ${dest}`);
  }

  console.log("All unique carousel slides rendered successfully!");
}

main().catch(console.error);
