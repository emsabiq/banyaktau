import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, paths } from "./config.js";
import { clamp, safeFilename, splitLines } from "./util.js";

const fps = 30;
const minLongformDurationSec = 300;
const maxLongformDurationSec = 900;

/**
 * Resolves paths dynamically supporting both assets/personal and assets/music/personal
 */
async function getPersonalDir(subPath) {
  const path1 = path.resolve(paths.rootDir, "assets", "personal", subPath);
  const path2 = path.resolve(paths.rootDir, "assets", "music", "personal", subPath);
  try {
    await fs.access(path1);
    return path1;
  } catch {
    return path2;
  }
}

/**
 * Select a random intro video for the category, fallback to 'umum' if category does not exist.
 */
async function selectIntroVideo(category) {
  const introsDir = await getPersonalDir("intros");
  let catFolder = "umum";
  const catLower = String(category || "").toLowerCase();
  
  if (catLower.includes("sain") || catLower.includes("alam") || catLower.includes("tubuh") || catLower.includes("ekologi")) {
    catFolder = "sains";
  } else if (catLower.includes("sejarah") || catLower.includes("tokoh") || catLower.includes("budaya")) {
    catFolder = "sejarah";
  } else if (catLower.includes("teknologi") || catLower.includes("penemuan") || catLower.includes("material") || catLower.includes("benda") || catLower.includes("peta")) {
    catFolder = "teknologi";
  } else if (catLower.includes("bisnis")) {
    catFolder = "bisnis";
  } else if (catLower.includes("misteri")) {
    catFolder = "misteri";
  }

  let searchDir = path.join(introsDir, catFolder);
  try {
    await fs.access(searchDir);
  } catch {
    searchDir = path.join(introsDir, "umum");
  }

  try {
    const files = (await fs.readdir(searchDir)).filter(f => f.toLowerCase().endsWith(".mp4"));
    if (files.length > 0) {
      const selected = files[Math.floor(Math.random() * files.length)];
      return path.join(searchDir, selected);
    }
  } catch (e) {
    console.warn("Gagal membaca folder intro:", e.message);
  }
  return path.join(introsDir, "umum", "intro-1.mp4");
}

/**
 * Select a random general outro video.
 */
async function selectOutroVideo() {
  const outrosDir = await getPersonalDir(path.join("outros", "umum"));
  try {
    const files = (await fs.readdir(outrosDir)).filter(f => f.toLowerCase().endsWith(".mp4"));
    if (files.length > 0) {
      const selected = files[Math.floor(Math.random() * files.length)];
      return path.join(outrosDir, selected);
    }
  } catch (e) {
    console.warn("Gagal membaca folder outro:", e.message);
  }
  return path.join(outrosDir, "outro-1.mp4");
}

/**
 * Select a random reaction video.
 */
async function selectReactionVideo(cue = "") {
  const reactionsDir = await getPersonalDir("reactions");
  try {
    const files = (await fs.readdir(reactionsDir)).filter(f => f.toLowerCase().endsWith(".mp4"));
    if (files.length > 0) {
      const cueText = String(cue || "").toLowerCase();
      const preferredNames = cueText.includes("kaget") || cueText.includes("kejutan")
        ? ["kaget"]
        : cueText.includes("petunjuk") || cueText.includes("temu")
          ? ["petunjuk", "tekatekipetunjuk", "somethingmissing"]
          : cueText.includes("setuju") || cueText.includes("mantap")
            ? ["mantap", "fakta"]
            : cueText.includes("skeptis") || cueText.includes("kenapa") || cueText.includes("heran")
              ? ["hmmkenapabisa", "somethingmissing"]
              : [];
      const preferred = files.filter((file) => preferredNames.some((name) => file.toLowerCase().includes(name)));
      const pool = preferred.length ? preferred : files;
      const selected = pool[Math.floor(Math.random() * pool.length)];
      return path.join(reactionsDir, selected);
    }
  } catch (e) {
    console.warn("Gagal membaca folder reaction:", e.message);
  }
  return null;
}

/**
 * Prepare bumper by scaling, setting fps to 30 and audio channels to stereo/44100Hz
 */
async function prepareBumper(bumperPath, outputPath) {
  await runFfmpeg([
    "-y",
    "-i", bumperPath,
    "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p",
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

/**
 * Make Category Intro Segment — full frame presenter video (no chroma keying).
 * User preference: intro/outro ditampilkan full frame, hanya reaction yang pakai keying.
 */
async function makeIntroSegment({ bgPath, bgType, introPath, outputPath, duration, bgMusicPath }) {
  await runFfmpeg([
    "-y",
    "-i", introPath,
    "-stream_loop", "-1",
    "-i", bgMusicPath,
    "-filter_complex",
    [
      `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p[v]`,
      `[0:a]volume=1.0[speech]`,
      `[1:a]volume=0.06[music]`,
      `[speech][music]amix=inputs=2:duration=first,alimiter=limit=0.95[a]`
    ].join(";"),
    "-map", "[v]",
    "-map", "[a]",
    "-t", String(duration),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-r", String(fps),
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

/**
 * Make Category Outro Segment. If BANYAKTAU_KEY_INTRO_OUTRO is true, key presenter and overlay on blurred bg.
 */
async function makeOutroSegment({ bgPath, bgType, outroPath, outputPath, duration, bgMusicPath, musicOffset }) {
  const fadeOutAt = Math.max(0.1, duration - 1.5).toFixed(2);

  await runFfmpeg([
    "-y",
    "-i", outroPath,
    "-stream_loop", "-1",
    "-i", bgMusicPath,
    "-filter_complex",
    [
      `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p[v]`,
      `[0:a]volume=1.0[speech]`,
      `[1:a]volume=0.06,afade=t=out:st=${fadeOutAt}:d=1.5[music]`,
      `[speech][music]amix=inputs=2:duration=first,alimiter=limit=0.95[a]`
    ].join(";"),
    "-map", "[v]",
    "-map", "[a]",
    "-t", String(duration),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-r", String(fps),
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

/**
 * Make audio block for the content scenes, mixing voiceover with background music.
 */
async function makeContentAudio({ narrationPath, musicPath, outputPath, duration, tempo, scenes }) {
  const narrationScenes = scenes.filter((scene) => scene.sceneType !== "reaction");
  const splitLabels = narrationScenes.map((_, index) => `[n${index}]`).join("");
  const narrationFilters = [
    "aformat=sample_rates=44100:channel_layouts=stereo",
    ...atempoFilters(tempo),
    "loudnorm=I=-16:TP=-1.5:LRA=9",
    "volume=1.08"
  ].join(",");
  const timelineFilters = [`[0:a]${narrationFilters},asplit=${narrationScenes.length}${splitLabels}`];
  const timelineParts = [];
  let narrationIndex = 0;

  scenes.forEach((scene, index) => {
    const label = `part${index}`;
    if (scene.sceneType === "reaction") {
      timelineFilters.push(
        `anullsrc=r=44100:cl=stereo,atrim=duration=${scene.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[${label}]`
      );
    } else {
      timelineFilters.push(
        `[n${narrationIndex}]atrim=start=${scene.narrationStartSec.toFixed(3)}:end=${scene.narrationEndSec.toFixed(3)},asetpts=PTS-STARTPTS[${label}]`
      );
      narrationIndex += 1;
    }
    timelineParts.push(`[${label}]`);
  });
  timelineFilters.push(`${timelineParts.join("")}concat=n=${timelineParts.length}:v=0:a=1[timeline]`);

  await runFfmpeg([
    "-y",
    "-i", narrationPath,
    "-stream_loop", "-1",
    "-i", musicPath,
    "-filter_complex",
    [
      ...timelineFilters,
      `[1:a]volume=0.06[music]`,
      `[timeline][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`
    ].join(";"),
    "-map", "[a]",
    "-t", String(duration),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

/**
 * Make music-only audio block for content scenes if narration is missing.
 */
async function makeContentAudioOnlyMusic({ musicPath, outputPath, duration, musicOffset }) {
  await runFfmpeg([
    "-y",
    "-stream_loop", "-1",
    "-i", musicPath,
    "-filter_complex",
    `[0:a]volume=0.06[music]`,
    "-map", "[music]",
    "-t", String(duration),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

/**
 * Merender video horizontal landscape (16:9) dari draft naskah panjang.
 * @param {object} item - Objek item naskah panjang
 * @returns {Promise<object>} - Hasil data video yang dirender
 */
export async function renderLongformVideo(item) {
  const workDir = path.join(paths.workDir, item.id);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(paths.videoDir, { recursive: true });

  const customMusic = await findBackgroundMusic();
  if (!customMusic) {
    throw new Error("Background music not found! Please place Marimba Curiosity Case MP3 under assets/music.");
  }

  const bumperIntroRaw = path.join(paths.rootDir, "assets", "bumper-yt", "bumper-youtube-intro.mp4");
  const bumperOutroRaw = path.join(paths.rootDir, "assets", "bumper-yt", "bumper-youtube-outro.mp4");
  const bumperIntroDuration = await probeDuration(bumperIntroRaw);
  const bumperOutroDuration = await probeDuration(bumperOutroRaw);

  // 1. Select the intro and outro videos
  const introVideoPath = await selectIntroVideo(item.input?.category);
  const outroVideoPath = await selectOutroVideo();

  // 2. Probe durations of selected intro/outro
  const introDuration = await probeDuration(introVideoPath);
  const outroDuration = await probeDuration(outroVideoPath);
  console.log(`Selected Category Intro: ${introVideoPath} (${introDuration}s)`);
  console.log(`Selected Outro: ${outroVideoPath} (${outroDuration}s)`);

  // Mode baru: TTS per scene (termasuk reaction). Durasi visual mengikuti durasi audio
  // sehingga subtitle dan suara selalu sinkron dan tidak ada narasi yang terpotong.
  const sceneAudioEntries = Array.isArray(item.assets?.sceneAudio) ? item.assets.sceneAudio : [];
  const hasSceneAudio = sceneAudioEntries.some((entry) => entry?.path);

  let timing;
  let renderScenes;

  if (hasSceneAudio) {
    const built = await buildSceneAudioTiming(item, {
      introDuration,
      outroDuration,
      bumperIntroDuration,
      bumperOutroDuration
    });
    timing = built.timing;
    renderScenes = built.renderScenes;
  } else {
    const narrationDuration = item.assets?.audio?.path ? await probeDuration(item.assets.audio.path) : 0;
    timing = buildTiming(item, narrationDuration, introDuration, outroDuration, bumperIntroDuration, bumperOutroDuration);
    renderScenes = buildRenderScenes(item, timing.adjustedNarrationDuration, timing.contentDuration);
  }

  // Content segments visual rendering
  const contentSegmentPaths = [];
  for (let index = 0; index < renderScenes.length; index += 1) {
    const scene = renderScenes[index];
    const segmentPath = path.join(workDir, `content-segment-${String(index).padStart(2, "0")}.mp4`);

    if (scene.sceneType === "reaction") {
      const reactionPath = await selectReactionVideo(`${scene.reactionCue || ""} ${scene.screenText || ""}`);
      if (!reactionPath) throw new Error(`Asset reaction untuk scene ${scene.index} tidak tersedia.`);
      console.log(`Rendering reaction scene ${index + 1}/${renderScenes.length} (${scene.durationSec}s): ${path.basename(reactionPath)}...`);
      await makeReactionSegment({
        reactionPath,
        outputPath: segmentPath,
        duration: scene.durationSec
      });
    } else {
      const media = resolveSceneMedia(item, scene);
      console.log(`Rendering ${scene.sceneType || "image"} scene ${index + 1}/${renderScenes.length} (${scene.durationSec}s)...`);
      if (media.type === "video") {
      await makeVideoSegment({
        videoPath: media.path,
        outputPath: segmentPath,
        duration: scene.durationSec
      });
      } else {
        await makeImageSegment({
          imagePath: media.path,
          outputPath: segmentPath,
          duration: scene.durationSec,
          zoomDirection: index % 2 ? "out" : "in"
        });
      }
    }
    contentSegmentPaths.push(segmentPath);
  }

  // Concatenate all content visual segments
  const contentVisualPath = path.join(workDir, "content-visual.mp4");
  await concatSegments(contentSegmentPaths, contentVisualPath);

  // Write content captions ASS file
  const contentAssPath = path.join(workDir, "content-captions.ass");
  await writeContentCaptionAss({
    outputPath: contentAssPath,
    item,
    scenes: renderScenes,
    contentDuration: timing.contentDuration
  });

  // Burn subtitles on content visual
  const contentSubtitledPath = path.join(workDir, "content-subtitled.mp4");
  await burnSubtitles({ inputPath: contentVisualPath, assPath: contentAssPath, outputPath: contentSubtitledPath });

  // Add watermark logo to content
  const contentBrandedPath = path.join(workDir, "content-branded.mp4");
  await addLogoWatermark({ inputPath: contentSubtitledPath, outputPath: contentBrandedPath });

  // Generate audio for content
  const contentAudioPath = path.join(workDir, "content-audio.m4a");
  if (hasSceneAudio) {
    await makeContentAudioFromScenes({
      scenes: renderScenes,
      musicPath: customMusic,
      outputPath: contentAudioPath,
      duration: timing.contentDuration,
      workDir
    });
  } else if (item.assets?.audio?.path) {
    await makeContentAudio({
      narrationPath: item.assets.audio.path,
      musicPath: customMusic,
      outputPath: contentAudioPath,
      duration: timing.contentDuration,
      tempo: timing.narrationTempo,
      scenes: renderScenes
    });
  } else {
    await makeContentAudioOnlyMusic({
      musicPath: customMusic,
      outputPath: contentAudioPath,
      duration: timing.contentDuration,
      musicOffset: introDuration
    });
  }

  // Mux content video and audio
  const finalContentPath = path.join(workDir, "part-2-content.mp4");
  await muxVideoAudio({ videoPath: contentBrandedPath, audioPath: contentAudioPath, outputPath: finalContentPath });

  // Render Part 1 (Category Intro)
  const firstSceneMedia = resolveSceneMedia(item, renderScenes[0]);
  const introPartPath = path.join(workDir, "part-1-intro.mp4");
  console.log("Rendering Part 1 (Category Intro)...");
  await makeIntroSegment({
    bgPath: firstSceneMedia.path,
    bgType: firstSceneMedia.type,
    introPath: introVideoPath,
    outputPath: introPartPath,
    duration: introDuration,
    bgMusicPath: customMusic
  });

  // Render Part 3 (Category Outro)
  const lastSceneMedia = resolveSceneMedia(item, renderScenes.at(-1));
  const outroRawPath = path.join(workDir, "part-3-outro-raw.mp4");
  console.log("Rendering Part 3 Outro Visual & Audio...");
  await makeOutroSegment({
    bgPath: lastSceneMedia.path,
    bgType: lastSceneMedia.type,
    outroPath: outroVideoPath,
    outputPath: outroRawPath,
    duration: outroDuration,
    bgMusicPath: customMusic,
    musicOffset: introDuration + timing.contentDuration
  });

  // Outro = full-frame presenter video (no ringkasan text overlay)
  const finalOutroPath = outroRawPath;

  // Transcode Bumper Intro
  const finalBumperIntroPath = path.join(workDir, "part-0-bumper-intro.mp4");
  console.log("Transcoding Bumper Intro...");
  await prepareBumper(bumperIntroRaw, finalBumperIntroPath);

  // Transcode Bumper Outro
  const finalBumperOutroPath = path.join(workDir, "part-4-bumper-outro.mp4");
  console.log("Transcoding Bumper Outro...");
  await prepareBumper(bumperOutroRaw, finalBumperOutroPath);

  // Concatenate all 5 parts
  const coreParts = [
    finalBumperIntroPath,
    introPartPath,
    finalContentPath,
    finalOutroPath,
    finalBumperOutroPath
  ];

  const provider = item.assets?.audio?.provider || "local";
  const filename = `${item.id}-${provider}-${safeFilename(item.title)}.mp4`;
  const outputPath = path.join(paths.videoDir, filename);

  console.log("Concatenating all 5 parts into final video...");
  await concatSegments(coreParts, outputPath);

  return {
    path: outputPath,
    url: `/generated/videos/${filename}`,
    provider,
    durationSec: timing.totalDuration,
    scenes: renderScenes.length
  };
}

function buildTiming(item, narrationDuration, introDuration, outroDuration, bumperIntroDuration = 0, bumperOutroDuration = 0) {
  const requestedTotal = clamp(Number(item.input?.durationSec || minLongformDurationSec), minLongformDurationSec, maxLongformDurationSec);
  const fixedDuration = introDuration + outroDuration + bumperIntroDuration + bumperOutroDuration;
  const maxContent = Math.max(180, maxLongformDurationSec - fixedDuration);
  const requestedContent = Math.max(180, requestedTotal - fixedDuration);
  const reactionDuration = (item.plan?.scenes || [])
    .filter((scene) => scene.sceneType === "reaction")
    .reduce((sum, scene) => sum + estimateReactionDuration(scene), 0);
  const maxNarrationDuration = Math.max(60, maxContent - reactionDuration);

  // Tempo 1.0 dipertahankan agar suara dokumenter lebih natural.
  const forcedTempo = narrationDuration > maxNarrationDuration ? narrationDuration / maxNarrationDuration : 1;
  const narrationTempo = clamp(forcedTempo, 1, 1.2);
  const adjustedNarration = narrationDuration ? narrationDuration / narrationTempo : 0;
  const contentDuration = narrationDuration
    ? clamp(adjustedNarration + reactionDuration, 1, maxContent)
    : clamp(requestedContent, 180, maxContent);

  return {
    contentDuration,
    totalDuration: Number((contentDuration + fixedDuration).toFixed(2)),
    narrationTempo,
    adjustedNarrationDuration: adjustedNarration
  };
}

function buildRenderScenes(item, narrationDuration, contentDuration = narrationDuration) {
  const scenes = item.plan.scenes || [];
  const reactionDurations = scenes.map((scene) => scene.sceneType === "reaction" ? estimateReactionDuration(scene) : 0);
  const reactionDurationTotal = reactionDurations.reduce((sum, value) => sum + value, 0);
  const availableNarrationDuration = narrationDuration > 0
    ? narrationDuration
    : Math.max(1, contentDuration - reactionDurationTotal);
  const regularIndexes = scenes.map((scene, index) => scene.sceneType === "reaction" ? -1 : index).filter((index) => index >= 0);
  const regularWeights = regularIndexes.map((index) => Math.max(1, String(scenes[index].narration || "").split(/\s+/).length));
  const regularWeightTotal = regularWeights.reduce((sum, value) => sum + value, 0) || regularIndexes.length || 1;
  let cursor = 0;
  let narrationCursor = 0;
  let regularWeightIndex = 0;

  return scenes.map((scene, index) => {
    const durationSec = scene.sceneType === "reaction"
      ? reactionDurations[index]
      : (regularWeights[regularWeightIndex++] / regularWeightTotal) * availableNarrationDuration;
    const output = {
      ...scene,
      startSec: Number(cursor.toFixed(2)),
      durationSec: Number(durationSec.toFixed(2))
    };
    if (scene.sceneType !== "reaction") {
      output.narrationStartSec = Number(narrationCursor.toFixed(3));
      narrationCursor += durationSec;
      output.narrationEndSec = Number(narrationCursor.toFixed(3));
    }
    cursor += durationSec;
    output.endSec = Number(cursor.toFixed(2));
    return output;
  });
}

function estimateReactionDuration(scene) {
  const words = String(scene.screenText || scene.narration || "").split(/\s+/).filter(Boolean).length;
  return clamp(words / 3.2 + 0.35, 2.8, 4);
}

/**
 * Build timing + render scenes ketika tiap scene punya file audio TTS sendiri.
 * Durasi tiap scene = durasi audio aslinya (plus jeda kecil), sehingga visual,
 * audio, dan subtitle otomatis sinkron. Reaction juga punya suara sendiri.
 */
async function buildSceneAudioTiming(item, { introDuration, outroDuration, bumperIntroDuration = 0, bumperOutroDuration = 0 }) {
  const scenes = item.plan?.scenes || [];
  const sceneAudio = Array.isArray(item.assets?.sceneAudio) ? item.assets.sceneAudio : [];
  const audioByIndex = new Map(sceneAudio.map((entry) => [Number(entry.sceneIndex), entry]));

  // Jeda kecil di akhir tiap scene agar narasi tidak terdengar dempet/terpotong.
  const tailPadByType = { reaction: 0.25, summary: 0.6, image: 0.35 };
  const minDurationByType = { reaction: 2.4, summary: 3.0, image: 1.5 };

  let cursor = 0;
  const renderScenes = [];

  for (const scene of scenes) {
    const entry = audioByIndex.get(Number(scene.index));
    const audioDuration = entry?.path ? await probeDuration(entry.path) : 0;
    const type = scene.sceneType || "image";
    const tailPad = tailPadByType[type] ?? 0.35;
    const minDuration = minDurationByType[type] ?? 1.5;

    const durationSec = Math.max(minDuration, (audioDuration || estimateReactionDuration(scene)) + tailPad);

    renderScenes.push({
      ...scene,
      sceneAudioPath: entry?.path || null,
      sceneCaptions: Array.isArray(entry?.captions) ? entry.captions : [],
      audioDurationSec: Number(audioDuration.toFixed(3)),
      startSec: Number(cursor.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      endSec: Number((cursor + durationSec).toFixed(3))
    });
    cursor += durationSec;
  }

  const contentDuration = Number(cursor.toFixed(3));
  const fixedDuration = introDuration + outroDuration + bumperIntroDuration + bumperOutroDuration;

  return {
    renderScenes,
    timing: {
      contentDuration,
      totalDuration: Number((contentDuration + fixedDuration).toFixed(2)),
      narrationTempo: 1,
      adjustedNarrationDuration: contentDuration
    }
  };
}

/**
 * Bangun audio konten dari potongan audio per scene.
 * Setiap scene (image/summary/reaction) ditempel sesuai durasinya, lalu di-pad
 * dengan silence agar pas dengan durasi visual, dan dicampur musik latar.
 */
async function makeContentAudioFromScenes({ scenes, musicPath, outputPath, duration, workDir }) {
  const inputs = [];
  const filters = [];
  const partLabels = [];
  let inputIndex = 0;

  scenes.forEach((scene, index) => {
    const label = `part${index}`;
    const sceneDuration = Number(scene.durationSec || 0);
    if (scene.sceneAudioPath) {
      inputs.push("-i", scene.sceneAudioPath);
      const audioInputIdx = inputIndex++;
      // Format ke stereo 44.1k, lalu pad/trim tepat ke durasi scene.
      filters.push(
        `[${audioInputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,`
        + `loudnorm=I=-16:TP=-1.5:LRA=9,volume=1.08,`
        + `apad,atrim=duration=${sceneDuration.toFixed(3)},asetpts=PTS-STARTPTS[${label}]`
      );
    } else {
      // Scene tanpa audio (mis. fallback) → silence sepanjang durasinya.
      filters.push(
        `anullsrc=r=44100:cl=stereo,atrim=duration=${sceneDuration.toFixed(3)},asetpts=PTS-STARTPTS[${label}]`
      );
    }
    partLabels.push(`[${label}]`);
  });

  filters.push(`${partLabels.join("")}concat=n=${partLabels.length}:v=0:a=1[timeline]`);

  // Musik latar sebagai input terakhir (looping).
  inputs.push("-stream_loop", "-1", "-i", musicPath);
  const musicInputIdx = inputIndex;
  filters.push(`[${musicInputIdx}:a]volume=0.06[music]`);
  filters.push(`[timeline][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`);

  await runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[a]",
    "-t", String(duration),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
}

function resolveSceneMedia(item, scene) {
  const sourceIndex = scene.imageSourceSceneIndex || scene.index;

  // Cek jika ada klip video dari Pexels
  const clip = item.assets?.clips?.find((entry) => Number(entry.sceneIndex) === Number(sourceIndex));
  if (clip?.path) {
    return { type: "video", path: clip.path };
  }

  // Fallback ke gambar DALL-E
  const image = item.assets?.images?.find((entry) => Number(entry.sceneIndex) === Number(sourceIndex));
  if (!image?.path) throw new Error(`Media (klip video / gambar) untuk scene ${sourceIndex} belum tersedia.`);
  return { type: "image", path: image.path };
}

async function makeVideoSegment({ videoPath, outputPath, duration }) {
  const bgFilter = [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720"
  ].join(",");

  await runFfmpeg([
    "-y",
    "-stream_loop", "-1",
    "-i", videoPath,
    "-t", String(duration),
    "-vf", bgFilter,
    "-r", String(fps),
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function makeImageSegment({ imagePath, outputPath, duration, zoomDirection }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const zoomExpr = zoomDirection === "out"
    ? `if(eq(on,0),1.055,max(1.0,zoom-0.00035))`
    : `min(1.0+on*0.00035,1.055)`;
  
  const bgFilter = [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720",
    `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=${fps}`,
    "eq=contrast=1.04:saturation=1.06:brightness=0.01"
  ].join(",");

  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-vf", bgFilter,
    "-frames:v", String(frames),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function makeReactionSegment({ reactionPath, outputPath, duration }) {
  const targetDuration = Math.max(0.5, Number(duration || 4));
  const sourceDuration = await probeDuration(reactionPath);
  // Loop sumber bila lebih pendek dari durasi target (audio reaction bisa lebih panjang dari klip).
  const needsLoop = sourceDuration > 0 && sourceDuration < targetDuration + 0.1;
  const maxOffset = Math.max(0, sourceDuration - targetDuration - 0.05);
  const startOffset = !needsLoop && maxOffset > 0.5 ? Math.random() * Math.min(maxOffset, 1.5) : 0;

  await runFfmpeg([
    "-y",
    ...(needsLoop ? ["-stream_loop", "-1"] : ["-ss", startOffset.toFixed(2)]),
    "-i", reactionPath,
    "-t", targetDuration.toFixed(3),
    "-vf", [
      "scale=1280:720:force_original_aspect_ratio=increase",
      "crop=1280:720",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.16:t=fill",
      "format=yuv420p"
    ].join(","),
    "-r", String(fps),
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function concatSegments(segmentPaths, outputPath) {
  const listPath = `${outputPath}.txt`;
  const list = segmentPaths.map((file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, `${list}\n`, "utf8");
  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outputPath
  ]);
}

async function burnSubtitles({ inputPath, assPath, outputPath }) {
  const subtitlePath = filterPath(path.relative(paths.rootDir, assPath));
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-vf", `ass=filename='${subtitlePath}'`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function addLogoWatermark({ inputPath, outputPath }) {
  const logoPath = path.join(paths.publicDir, "assets", "banyaktau-logo-watermark.png");
  try {
    await fs.access(logoPath);
  } catch {
    await fs.copyFile(inputPath, outputPath);
    return;
  }

  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-i", logoPath,
    "-filter_complex",
    [
      "[1:v]scale=180:-1,format=rgba,colorchannelmixer=aa=0.72[wm]",
      "[0:v][wm]overlay=W-w-30:30:format=auto[v]"
    ].join(";"),
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function findBackgroundMusic() {
  const candidates = [
    path.join(paths.rootDir, "assets", "music", "Marimba Curiosity Case (5 Minute Version).mp3"),
    process.env.BANYAKTAU_MUSIC_PATH,
    path.join(paths.rootDir, "assets", "music", "eksplorasi-literasi.m4a"),
    path.join(paths.rootDir, "assets", "music", "eksplorasi-literasi.mp3")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return "";
}

async function muxVideoAudio({ videoPath, audioPath, outputPath }) {
  await runFfmpeg([
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath
  ]);
}

async function writeContentCaptionAss({ outputPath, item, scenes, contentDuration }) {
  const events = [];
  const titleText = splitLines(item.title || item.plan?.title || "BanyakTau", 30, 2).join("\\N");
  events.push(dialogue(0.05, Math.max(0.1, contentDuration - 0.5), "SceneTitle", `{\\fad(150,150)}${assEscape(titleText)}`));

  for (const scene of scenes) {
    if (scene.sceneType === "reaction") {
      const prompt = splitLines(scene.screenText || scene.narration, 34, 3).join("\\N");
      events.push(dialogue(
        scene.startSec + 0.08,
        Math.max(scene.startSec + 0.3, scene.endSec - 0.08),
        "ReactionPrompt",
        `{\\fad(120,160)}${assEscape(prompt)}`
      ));
    }
    if (scene.sceneType === "summary") {
      const summary = splitLines(outroSummaryText(item).replace(/\\N/g, " "), 48, 4).join("\\N");
      const points = (item.plan?.importantPoints || [])
        .map((point) => normalizeSubtitleText(point))
        .filter(Boolean)
        .slice(0, 3)
        .map((point) => splitLines(`- ${point.replace(/[.]+$/g, "")}`, 54, 2).join("\\N  "))
        .join("\\N");
      events.push(dialogue(
        scene.startSec + 0.08,
        Math.max(scene.startSec + 0.3, scene.endSec - 0.08),
        "SummaryDim",
        "{\\an7\\pos(0,0)\\p1}m 0 0 l 1280 0 l 1280 720 l 0 720"
      ));
      events.push(dialogue(
        scene.startSec + 0.2,
        Math.max(scene.startSec + 0.5, scene.endSec - 0.1),
        "SummaryTitle",
        "{\\fad(150,180)}Ringkasan Inti"
      ));
      events.push(dialogue(
        scene.startSec + 0.55,
        Math.max(scene.startSec + 0.8, scene.endSec - 0.1),
        "SummaryText",
        `{\\fad(150,180)}${assEscape(summary)}`
      ));
      if (points) {
        events.push(dialogue(
          scene.startSec + 1.0,
          Math.max(scene.startSec + 1.3, scene.endSec - 0.1),
          "SummaryPoints",
          `{\\fad(150,180)}${assEscape(points)}`
        ));
      }
    }
  }

  const subtitleEnd = Math.max(0.2, contentDuration - 0.08);
  for (const caption of sceneCaptionSegments(scenes)) {
    const start = Math.min(caption.start, subtitleEnd);
    const end = Math.min(caption.end, subtitleEnd);
    if (end - start >= 0.25) {
      events.push(dialogue(start, end, "Subtitle", `{\\fad(50,50)}${assEscape(caption.text)}`));
    }
  }

  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${config.render.fontTitle},42,&H00FFFFFF,&H000000FF,&H98232A32,&HBB11171C,-1,0,0,0,100,100,0,0,1,2.5,0,5,60,60,90,1`,
    `Style: SceneTitle,${config.render.fontTitle},30,&H00F7F2DC,&H000000FF,&H90222A2C,&HAA15191D,-1,0,0,0,100,100,0,0,1,2,0,7,40,240,58,1`,
    `Style: Subtitle,${config.render.fontBody},42,&H00FFFFFF,&H000000FF,&H9A11171B,&HBF11171B,-1,0,0,0,100,100,0,0,1,3,1,2,92,92,58,1`,
    `Style: ReactionPrompt,${config.render.fontBody},46,&H00FFFFFF,&H000000FF,&H9011171B,&HCC11171B,-1,0,0,0,100,100,0,0,3,18,0,2,120,120,72,1`,
    `Style: SummaryDim,${config.render.fontBody},20,&H76000000,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: SummaryTitle,${config.render.fontBody},44,&H00FFFFFF,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2,0,8,80,80,80,1`,
    `Style: SummaryText,${config.render.fontBody},29,&H00FFFFFF,&H000000FF,&H9011171B,&H0011171B,0,0,0,0,100,100,0,0,1,1.5,0,8,120,120,170,1`,
    `Style: SummaryPoints,${config.render.fontBody},27,&H00F7F2DC,&H000000FF,&H9011171B,&H0011171B,0,0,0,0,100,100,0,0,1,1.5,0,8,140,140,330,1`,
    `Style: Point,${config.render.fontBody},44,&H00FFFFFF,&H000000FF,&H8F11171B,&HCC11171B,-1,0,0,0,100,100,0,0,3,10,0,5,80,80,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events
  ].join("\n");

  await fs.writeFile(outputPath, ass, "utf8");
}

async function writeOutroCaptionAss({ outputPath, item, duration }) {
  const events = [];
  const fade = "{\\fad(180,220)}";
  const summary = outroSummaryText(item);
  const points = outroPointText(item);

  events.push(
    dialogue(0, duration, "OutroDim", `${fade}{\\an7\\pos(0,0)\\p1}m 0 0 l 1280 0 l 1280 720 l 0 720`),
    dialogue(0.16, duration, "OutroKicker", `${fade}{\\an5\\pos(640,150)}${assEscape("RINGKASAN KUNCI")}`),
    dialogue(0.38, duration, "OutroSummary", `${fade}{\\an5\\pos(640,300)}${assEscape(summary)}`)
  );

  if (points) {
    events.push(dialogue(0.78, duration, "OutroPoint", `${fade}{\\an5\\pos(640,480)}${assEscape(points)}`));
  }

  events.push(dialogue(Math.max(0, duration - 1.15), duration, "OutroBrand", `{\\fad(120,220)}{\\an3\\pos(1220,660)}${assEscape("BanyakTau")}`));

  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: OutroDim,${config.render.fontBody},20,&H82000000,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroCard,${config.render.fontBody},20,&H1811171B,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroAccent,${config.render.fontBody},20,&H004CC8F5,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroKicker,${config.render.fontMono},22,&H004CC8F5,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,1.5,0,5,60,60,540,1`,
    `Style: OutroTitle,${config.render.fontTitle},36,&H00FFFFFF,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2,0,7,60,60,570,1`,
    `Style: OutroSummary,${config.render.fontBody},28,&H00FFFFFF,&H000000FF,&H9211171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2,0,5,60,60,350,1`,
    `Style: OutroPoint,${config.render.fontBody},24,&H00F7F2DC,&H000000FF,&H9511171B,&H0011171B,-1,0,0,0,100,100,0,0,1,1.8,0,5,60,60,190,1`,
    `Style: OutroBrand,${config.render.fontMono},22,&H004CC8F5,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,1.5,0,3,60,60,60,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events
  ].join("\n");

  await fs.writeFile(outputPath, ass, "utf8");
}

function outroSummaryText(item) {
  const summary = normalizeOutroText(item.plan?.summary);
  const points = (item.plan?.importantPoints || []).map(normalizeOutroText).filter(Boolean);
  const fallback = points.length
    ? points.join(". ")
    : normalizeOutroText(item.plan?.scenes?.at(-1)?.narration || item.plan?.hook || "Simpan inti fakta ini dan cari tahu lebih banyak.");
  const text = compactOutroSummary(summary.length >= 80 ? summary : fallback, points);
  return wrapOutroLines(text, 48, 4, { truncate: false }).join("\\N");
}

function outroPointText(item) {
  const points = (item.plan?.importantPoints || [])
    .map(normalizeOutroText)
    .filter(Boolean)
    .filter((point) => point.length >= 18)
    .slice(0, 2);
  return points.map((point) => splitLines(`- ${point.replace(/[.]+$/g, "")}`, 48, 2).join("\\N  ")).join("\\N");
}

function normalizeOutroText(value) {
  return normalizeSubtitleText(value)
    .replace(/^intinya,\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactOutroSummary(value, points = []) {
  const text = normalizeOutroText(value);
  const completeSentences = sentenceList(text);
  const pointSentences = points
    .map((point) => ensureSentence(point.replace(/[.]+$/g, "")))
    .filter(Boolean);
  const candidates = [
    completeSentences.length >= 2 ? `${completeSentences[0]} ${completeSentences[1]}` : "",
    completeSentences[0] || "",
    ...pointSentences,
    text ? ensureSentence(text.replace(/[.]+$/g, "")) : ""
  ].filter(Boolean);

  for (const candidate of uniqueStrings(candidates)) {
    if (fitsOutroSummary(candidate)) return candidate;
  }

  return shortenOutroSentence(candidates[0] || "Simpan inti faktanya dan cari tahu lebih banyak.");
}

function sentenceList(value) {
  return (normalizeOutroText(value).match(/[^.!?]+[.!?]+/g) || [])
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function ensureSentence(value) {
  const text = normalizeOutroText(value).replace(/[,:;]+$/g, "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeOutroText(value).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fitsOutroSummary(value) {
  return wrapOutroLines(value, 48, Number.POSITIVE_INFINITY, { truncate: false }).length <= 4;
}

function shortenOutroSentence(value) {
  const words = normalizeOutroText(value).replace(/[.]+$/g, "").split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 48 && line) {
      lines.push(line);
      if (lines.length >= 4) break;
      line = word;
    } else {
      line = next;
    }
  }
  if (lines.length < 4 && line) lines.push(line);
  return ensureSentence(lines.join(" "));
}

function wrapOutroLines(value, maxChars, maxLines, options = {}) {
  const words = normalizeOutroText(value).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);

  if (options.truncate === false) return lines;
  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const last = limited.at(-1) || "";
    if (last.length < 12) limited.pop();
    else limited[limited.length - 1] = last.replace(/[,:;]+$/g, "").trim();
  }
  return limited;
}

function shortenOverlayLine(value) {
  const text = polishOverlayLine(normalizeSubtitleText(value));
  if (text.length <= 44) return text;
  const clipped = text.slice(0, 44);
  const atSpace = clipped.lastIndexOf(" ");
  return clipped.slice(0, atSpace > 28 ? atSpace : clipped.length).trim();
}

function polishOverlayLine(value) {
  const text = String(value || "")
    .replace(/\.$/, "")
    .trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function sceneCaptionSegments(scenes) {
  return scenes
    .filter((scene) => scene.sceneType !== "reaction" && scene.sceneType !== "summary")
    .flatMap((scene) => {
      // Gunakan timestamp transkripsi asli per scene bila tersedia (mode TTS per scene).
      const captions = Array.isArray(scene.sceneCaptions) ? scene.sceneCaptions : [];
      const audioDuration = Number(scene.audioDurationSec || 0);
      if (captions.length && audioDuration > 0) {
        return captions
          .filter((entry) => entry.text && Number(entry.end) > Number(entry.start))
          .flatMap((entry) => captionSegments(
            entry.text,
            scene.startSec + Number(entry.start),
            Math.min(scene.endSec - 0.05, scene.startSec + Number(entry.end))
          ));
      }
      // Fallback lama: bagi narasi berdasarkan proporsi kata.
      return captionSegments(
        scene.narration,
        scene.startSec + 0.05,
        Math.max(scene.startSec + 0.4, scene.endSec - 0.05)
      );
    });
}

function captionSegments(text, start, end) {
  const normalizedText = normalizeSubtitleText(text);
  const words = normalizedText.split(/\s+/).filter(Boolean);
  const duration = Math.max(0.1, end - start);
  if (!words.length || duration <= 0.2) return [];

  // Untuk video panjang horizontal, tampilkan 4-6 kata sekaligus agar subtitle besar tetap lega.
  const chunkSize = 5;
  const chunks = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(words.slice(index, index + chunkSize).join(" "));
  }
  if (chunks.length > 1 && chunks.at(-1).split(/\s+/).filter(Boolean).length < 3) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks.at(-1)} ${tail}`;
  }

  const totalWords = chunks.reduce((sum, chunk) => sum + chunk.split(/\s+/).filter(Boolean).length, 0) || 1;
  let cursor = start;
  return chunks.map((chunk, index) => {
    const weight = chunk.split(/\s+/).filter(Boolean).length / totalWords;
    const isLast = index === chunks.length - 1;
    const next = isLast ? end : Math.min(end, cursor + duration * weight);
    const segment = {
      start: cursor,
      end: Math.max(cursor + 0.35, next - 0.04),
      text: splitLines(normalizeSubtitleText(chunk), 34, 2).join("\\N")
    };
    cursor = next;
    return segment;
  });
}

function normalizeSubtitleText(value) {
  return String(value || "")
    .replace(/\bKesimpulan\s+Singkat\b/gi, "Fakta Utama")
    .replace(/\bkesimpulan\b/gi, "intinya")
    .replace(/\bekstrim\b/gi, "ekstrem")
    .replace(/\brapih\b/gi, "rapi")
    .replace(/\blembab\b/gi, "lembap")
    .replace(/\bnggak\b/gi, "tidak")
    .replace(/\bkayak\b/gi, "seperti")
    .replace(/\s+/g, " ")
    .trim();
}

function dialogue(start, end, style, text) {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const cs = Math.floor((value - Math.floor(value)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assEscape(value) {
  return String(value || "")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function filterPath(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/'/g, "\\'")
    .replace(/^([A-Za-z]):/, "$1\\\\:");
}

function atempoFilters(tempo) {
  const value = clamp(Number(tempo || 1), 0.5, 2);
  if (Math.abs(value - 1) < 0.01) return [];
  return [`atempo=${value.toFixed(3)}`];
}

async function probeDuration(filePath) {
  const output = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  return Number.parseFloat(output.trim()) || 0;
}

async function runFfmpeg(args) {
  await runCommand("ffmpeg", args);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: paths.rootDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(stderr || `${command} gagal (${code})`));
    });
  });
}
