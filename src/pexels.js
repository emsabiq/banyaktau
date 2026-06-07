import fs from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import { safeFilename } from "./util.js";

/**
 * Mencar dan mengunduh satu stock video dari Pexels API berdasarkan query kata kunci.
 * @param {object} params
 * @param {string} params.itemId - ID item proyek
 * @param {number} params.sceneIndex - Indeks scene/babak
 * @param {string} params.query - Kata kunci pencarian (misal: 'vintage camera film')
 * @param {number} params.targetDurationSec - Target durasi klip
 * @returns {Promise<{path: string, url: string, pexelsId: number} | null>}
 */
export async function downloadStockVideo({ itemId, sceneIndex, query, targetDurationSec }) {
  const apiKey = process.env.PEXELS_API_KEY || "";
  if (!apiKey) {
    console.log(`[Pexels] PEXELS_API_KEY tidak dikonfigurasi. Melewati unduhan stock video.`);
    return null;
  }

  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return null;

  try {
    console.log(`[Pexels] Mencari video untuk: "${cleanQuery}" (durasi target: ${targetDurationSec}s)...`);
    const searchUrl = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(cleanQuery)}&per_page=8&orientation=landscape`;
    
    const response = await fetch(searchUrl, {
      headers: {
        Authorization: apiKey
      }
    });

    if (!response.ok) {
      console.warn(`[Pexels] Gagal memanggil API: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (!videos.length) {
      console.log(`[Pexels] Tidak ada hasil video untuk: "${cleanQuery}"`);
      return null;
    }

    // Pilih video yang memiliki durasi cukup (diutamakan >= targetDurationSec)
    // dan memiliki file bertipe video/mp4 dengan rasio landscape
    let selectedVideo = null;
    let selectedFile = null;

    for (const video of videos) {
      // Cari file video MP4 HD
      const files = Array.isArray(video.video_files) ? video.video_files : [];
      // Urutkan agar HD duluan
      const mp4Files = files
        .filter(f => f.file_type === "video/mp4" && f.width > f.height)
        .sort((a, b) => {
          // Cari resolusi sedang (720p - 1080p) agar tidak terlalu berat diunduh
          const aDiff = Math.abs(a.width - 1280);
          const bDiff = Math.abs(b.width - 1280);
          return aDiff - bDiff;
        });

      if (mp4Files.length) {
        selectedVideo = video;
        selectedFile = mp4Files[0];
        // Jika durasinya cukup, kita langsung pakai
        if (video.duration >= targetDurationSec) {
          break;
        }
      }
    }

    if (!selectedFile || !selectedVideo) {
      console.log(`[Pexels] Tidak ada file MP4 landscape yang cocok.`);
      return null;
    }

    await fs.mkdir(paths.clipDir, { recursive: true });
    
    const ext = "mp4";
    const filename = `${itemId}-scene-${sceneIndex}-${safeFilename(cleanQuery.slice(0, 30))}.${ext}`;
    const outputPath = path.join(paths.clipDir, filename);

    console.log(`[Pexels] Mengunduh video ID ${selectedVideo.id} (${selectedFile.width}x${selectedFile.height}, ${selectedVideo.duration}s) dari URL: ${selectedFile.link}...`);
    
    const videoResponse = await fetch(selectedFile.link);
    if (!videoResponse.ok) {
      throw new Error(`Gagal mengunduh file video: HTTP ${videoResponse.status}`);
    }

    const arrayBuffer = await videoResponse.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
    console.log(`[Pexels] Berhasil menyimpan video ke: ${outputPath}`);

    return {
      path: outputPath,
      url: `/generated/clips/${filename}`,
      pexelsId: selectedVideo.id
    };
  } catch (error) {
    console.warn(`[Pexels] Terjadi kesalahan saat mengunduh stock video: ${error.message}`);
    return null;
  }
}
