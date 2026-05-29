import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, paths } from "./config.js";
import { clamp, safeFilename, splitLines } from "./util.js";

const fps = 30;
const introDuration = 3.0;
const outroDuration = 6.0;
const outroSummaryMaxChars = 36;
const outroSummaryMaxLines = 5;

export async function renderKnowledgeVideo(item) {
  const workDir = path.join(paths.workDir, item.id);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(paths.videoDir, { recursive: true });

  const narrationDuration = item.assets?.audio?.path ? await probeDuration(item.assets.audio.path) : 0;
  const timing = buildTiming(item, narrationDuration);
  const renderScenes = buildRenderScenes(item, timing.contentDuration);
  const allScenes = [buildIntroScene(item, renderScenes[0]), ...renderScenes, buildOutroScene(item, renderScenes.at(-1))];

  const segmentPaths = [];
  for (let index = 0; index < allScenes.length; index += 1) {
    const scene = allScenes[index];
    const media = resolveSceneMedia(item, scene);
    const segmentPath = path.join(workDir, `segment-${String(index).padStart(2, "0")}.mp4`);
    await makeImageSegment({ imagePath: media.path, outputPath: segmentPath, duration: scene.durationSec, zoomDirection: index % 2 ? "out" : "in" });
    segmentPaths.push(segmentPath);
  }

  const visualPath = path.join(workDir, "visual.mp4");
  await concatSegments(segmentPaths, visualPath);

  const assPath = path.join(workDir, "captions.ass");
  await writeCaptionAss({
    outputPath: assPath,
    item,
    scenes: renderScenes,
    narrationDuration,
    narrationTempo: timing.narrationTempo,
    totalDuration: timing.totalDuration
  });

  const subtitledPath = path.join(workDir, "visual-subtitled.mp4");
  await burnSubtitles({ inputPath: visualPath, assPath, outputPath: subtitledPath });

  const brandedPath = path.join(workDir, "visual-branded.mp4");
  await addLogoWatermark({ inputPath: subtitledPath, outputPath: brandedPath });

  const bedPath = path.join(workDir, "knowledge-bed.m4a");
  await makeKnowledgeBed({ outputPath: bedPath, duration: timing.totalDuration });

  const audioPath = item.assets?.audio?.path
    ? path.join(workDir, "final-audio.m4a")
    : bedPath;
  if (item.assets?.audio?.path) {
    await mixNarrationWithBed({
      narrationPath: item.assets.audio.path,
      bedPath,
      outputPath: audioPath,
      delaySec: introDuration,
      tempo: timing.narrationTempo
    });
  }

  const provider = item.assets?.audio?.provider || "local";
  const filename = `${item.id}-${provider}-${safeFilename(item.title)}.mp4`;
  const outputPath = path.join(paths.videoDir, filename);
  await muxVideoAudio({ videoPath: brandedPath, audioPath, outputPath });

  return {
    path: outputPath,
    url: `/generated/videos/${filename}`,
    provider,
    durationSec: Number((await probeDuration(outputPath)).toFixed(2)),
    scenes: renderScenes.length
  };
}

function buildTiming(item, narrationDuration) {
  const requestedTotal = clamp(Number(item.input?.durationSec || 90), 45, 120);
  const maxTotal = 120;
  const maxContent = maxTotal - introDuration - outroDuration;
  const requestedContent = requestedTotal - introDuration - outroDuration;
  const relaxedFastTempo = clamp(Number(config.render.speechTempo || 1.15), 0.9, 1.3);
  const forcedTempo = narrationDuration > maxContent ? narrationDuration / maxContent : 1;
  const narrationTempo = clamp(Math.max(relaxedFastTempo, forcedTempo), 0.9, 1.3);
  const adjustedNarration = narrationDuration ? narrationDuration / narrationTempo : 0;
  const contentDuration = narrationDuration
    ? clamp(Math.max(adjustedNarration + 0.35, 34), 34, maxContent)
    : clamp(Math.max(requestedContent, 34), 34, maxContent);
  return {
    contentDuration,
    totalDuration: Number((contentDuration + introDuration + outroDuration).toFixed(2)),
    narrationTempo
  };
}

function buildRenderScenes(item, contentDuration) {
  const scenes = item.plan.scenes || [];
  const weights = scenes.map((scene) => Math.max(1, String(scene.narration || "").split(/\s+/).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || scenes.length || 1;
  return scenes.map((scene, index) => ({
    ...scene,
    durationSec: Number(((weights[index] / totalWeight) * contentDuration).toFixed(2))
  }));
}

function buildIntroScene(item, firstScene) {
  return {
    kind: "intro",
    index: 0,
    durationSec: introDuration,
    screenText: item.plan.hook || item.title,
    narration: "",
    imageSourceSceneIndex: firstScene?.index || 1
  };
}

function buildOutroScene(item, lastScene) {
  return {
    kind: "outro",
    index: 999,
    durationSec: outroDuration,
    screenText: endOverlayText(item),
    narration: "",
    imageSourceSceneIndex: lastScene?.index || 1
  };
}

function resolveSceneMedia(item, scene) {
  if (scene.kind === "intro" && item.assets?.thumbnail?.path) {
    return { type: "image", path: item.assets.thumbnail.path };
  }
  const sourceIndex = scene.imageSourceSceneIndex || scene.index;
  const image = item.assets?.images?.find((entry) => Number(entry.sceneIndex) === Number(sourceIndex));
  if (!image?.path) throw new Error(`Gambar untuk scene ${sourceIndex} belum tersedia.`);
  return { type: "image", path: image.path };
}

async function makeImageSegment({ imagePath, outputPath, duration, zoomDirection }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const zoomExpr = zoomDirection === "out"
    ? `if(eq(on,0),1.055,max(1.0,zoom-0.00035))`
    : `min(1.0+on*0.00035,1.055)`;
  const vf = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${fps}`,
    "eq=contrast=1.04:saturation=1.06:brightness=0.01",
    "format=yuv420p"
  ].join(",");

  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-vf", vf,
    "-frames:v", String(frames),
    "-r", String(fps),
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
      "[1:v]scale=245:-1,format=rgba,colorchannelmixer=aa=0.78[wm]",
      "[0:v][wm]overlay=W-w-40:40:format=auto[v]"
    ].join(";"),
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    outputPath
  ]);
}

async function makeKnowledgeBed({ outputPath, duration }) {
  const customMusic = await findBackgroundMusic();
  if (customMusic) {
    await makeCustomMusicBed({ inputPath: customMusic, outputPath, duration });
    return;
  }

  const fadeOutAt = Math.max(0.1, duration - 1.2).toFixed(2);
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-t", duration.toFixed(2), "-i", "anoisesrc=color=pink:amplitude=0.018",
    "-f", "lavfi", "-t", duration.toFixed(2), "-i", "sine=frequency=174:sample_rate=44100",
    "-filter_complex",
    [
      "[0:a]lowpass=f=850,highpass=f=40,volume=0.028[a0]",
      `[1:a]volume=0.012,afade=t=in:st=0:d=2.2,afade=t=out:st=${fadeOutAt}:d=1.2[a1]`,
      "[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.62[a]"
    ].join(";"),
    "-map", "[a]",
    "-c:a", "aac",
    "-b:a", "128k",
    outputPath
  ]);
}

async function findBackgroundMusic() {
  const candidates = [
    process.env.BANYAKTAU_MUSIC_PATH,
    path.join(paths.rootDir, "assets", "music", "eksplorasi-literasi.m4a"),
    path.join(paths.rootDir, "assets", "music", "eksplorasi-literasi.mp3")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return "";
}

async function makeCustomMusicBed({ inputPath, outputPath, duration }) {
  const fadeOutAt = Math.max(0.1, duration - 1.4).toFixed(2);
  await runFfmpeg([
    "-y",
    "-stream_loop", "-1",
    "-i", inputPath,
    "-t", duration.toFixed(2),
    "-filter_complex",
    `aformat=sample_rates=44100:channel_layouts=stereo,volume=0.18,afade=t=in:st=0:d=1.4,afade=t=out:st=${fadeOutAt}:d=1.4,alimiter=limit=0.72[a]`,
    "-map", "[a]",
    "-c:a", "aac",
    "-b:a", "128k",
    outputPath
  ]);
}

async function mixNarrationWithBed({ narrationPath, bedPath, outputPath, delaySec, tempo }) {
  const delayMs = Math.max(0, Math.round(delaySec * 1000));
  const narrationFilters = [
    "aformat=sample_rates=44100:channel_layouts=mono",
    ...atempoFilters(tempo),
    "loudnorm=I=-16:TP=-1.5:LRA=9",
    "volume=1.08",
    `adelay=${delayMs}:all=1`
  ].join(",");
  await runFfmpeg([
    "-y",
    "-i", narrationPath,
    "-i", bedPath,
    "-filter_complex",
    [
      `[0:a]${narrationFilters}[n]`,
      "[1:a]volume=0.62[bed]",
      "[n][bed]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.96[a]"
    ].join(";"),
    "-map", "[a]",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath
  ]);
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

async function writeCaptionAss({ outputPath, item, scenes, narrationDuration, narrationTempo, totalDuration }) {
  const events = [];
  const titleText = splitLines(item.title || item.plan?.title || "BanyakTau", 24, 3).join("\\N");
  events.push(dialogue(introDuration + 0.05, Math.max(introDuration + 0.1, totalDuration - outroDuration), "SceneTitle", `{\\fad(140,160)}${assEscape(titleText)}`));

  let cursor = introDuration;
  for (const scene of scenes) {
    const end = cursor + scene.durationSec;
    cursor = end;
  }

  const subtitleEnd = Math.max(introDuration + 0.2, totalDuration - outroDuration - 0.08);
  for (const caption of timedCaptionSegments(item, {
    start: introDuration + 0.05,
    duration: narrationDuration ? narrationDuration / Math.max(0.1, Number(narrationTempo || 1)) : totalDuration - introDuration - outroDuration,
    tempo: narrationTempo
  })) {
    const start = Math.min(caption.start, subtitleEnd);
    const end = Math.min(caption.end, subtitleEnd);
    if (end - start >= 0.25) {
      events.push(dialogue(start, end, "Subtitle", `{\\fad(55,55)}${assEscape(caption.text)}`));
    }
  }

  events.push(...outroOverlayEvents(item, Math.max(0, totalDuration - outroDuration), totalDuration));

  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${config.render.fontTitle},74,&H00FFFFFF,&H000000FF,&H98232A32,&HBB11171C,-1,0,0,0,100,100,0,0,1,3.5,0,5,80,80,140,1`,
    `Style: SceneTitle,${config.render.fontTitle},42,&H00F7F2DC,&H000000FF,&H90222A2C,&HAA15191D,-1,0,0,0,100,100,0,0,1,2.5,0,7,54,340,78,1`,
    `Style: Subtitle,${config.render.fontBody},58,&H00FFFFFF,&H000000FF,&H9A11171B,&HBF11171B,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,550,1`,
    `Style: Point,${config.render.fontBody},72,&H00FFFFFF,&H000000FF,&H8F11171B,&HCC11171B,-1,0,0,0,100,100,0,0,3,18,0,5,96,96,0,1`,
    `Style: OutroDim,${config.render.fontBody},20,&H82000000,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroCard,${config.render.fontBody},20,&H1811171B,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroAccent,${config.render.fontBody},20,&H004CC8F5,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OutroKicker,${config.render.fontMono},34,&H004CC8F5,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2,0,7,104,104,800,1`,
    `Style: OutroTitle,${config.render.fontTitle},52,&H00FFFFFF,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2.5,0,7,104,104,870,1`,
    `Style: OutroSummary,${config.render.fontBody},45,&H00FFFFFF,&H000000FF,&H9211171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2.8,0,7,104,104,1104,1`,
    `Style: OutroPoint,${config.render.fontBody},38,&H00F7F2DC,&H000000FF,&H9511171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2.2,0,7,104,104,1380,1`,
    `Style: OutroBrand,${config.render.fontMono},30,&H004CC8F5,&H000000FF,&H9011171B,&H0011171B,-1,0,0,0,100,100,0,0,1,2,0,2,90,90,170,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events
  ].join("\n");

  await fs.writeFile(outputPath, ass, "utf8");
}

function endOverlayText(item) {
  const points = (item.plan?.importantPoints || [])
    .filter(Boolean)
    .slice(0, 2)
    .map((point) => shortenOverlayLine(point))
    .filter(Boolean);
  if (points.length) return points.join("\\N");

  return splitLines(shortenOverlayLine(item.plan?.summary || "Simpan rasa penasaranmu."), 22, 2).join("\\N");
}

function outroOverlayEvents(item, start, end) {
  const fade = "{\\fad(180,220)}";
  const summary = outroSummaryText(item);
  const points = outroPointText(item);
  const events = [
    dialogue(start, end, "OutroDim", `${fade}{\\an7\\pos(0,0)\\p1}m 0 0 l 1080 0 l 1080 1920 l 0 1920`),
    dialogue(start + 0.16, end, "OutroKicker", `${fade}{\\an5\\pos(540,520)}${assEscape("RINGKASAN INTI")}`),
    dialogue(start + 0.38, end, "OutroSummary", `${fade}{\\an5\\pos(540,850)}${assEscape(summary)}`)
  ];

  if (points) {
    events.push(dialogue(start + 0.78, end, "OutroPoint", `${fade}{\\an5\\pos(540,1240)}${assEscape(points)}`));
  }

  events.push(dialogue(Math.max(start, end - 1.15), end, "OutroBrand", `{\\fad(120,220)}${assEscape("BanyakTau")}`));
  return events;
}

function outroSummaryText(item) {
  const summary = normalizeOutroText(item.plan?.summary);
  const points = (item.plan?.importantPoints || []).map(normalizeOutroText).filter(Boolean);
  const fallback = points.length
    ? points.join(". ")
    : normalizeOutroText(item.plan?.scenes?.at(-1)?.narration || item.plan?.hook || "Simpan inti faktanya dan lanjut cari tahu lebih banyak.");
  const text = compactOutroSummary(summary.length >= 60 ? summary : fallback, points);
  return wrapOutroLines(text, outroSummaryMaxChars, outroSummaryMaxLines, { truncate: false }).join("\\N");
}

function outroPointText(item) {
  const points = (item.plan?.importantPoints || [])
    .map(normalizeOutroText)
    .filter(Boolean)
    .filter((point) => point.length >= 18)
    .slice(0, 2);
  return points.map((point) => splitLines(`- ${point.replace(/[.]+$/g, "")}`, 38, 2).join("\\N  ")).join("\\N");
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

  return shortenOutroSentence(candidates[0] || "Simpan inti faktanya dan lanjut cari tahu lebih banyak.");
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
  return wrapOutroLines(value, outroSummaryMaxChars, Number.POSITIVE_INFINITY, { truncate: false }).length <= outroSummaryMaxLines;
}

function shortenOutroSentence(value) {
  const words = normalizeOutroText(value).replace(/[.]+$/g, "").split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > outroSummaryMaxChars && line) {
      lines.push(line);
      if (lines.length >= outroSummaryMaxLines) break;
      line = word;
    } else {
      line = next;
    }
  }
  if (lines.length < outroSummaryMaxLines && line) lines.push(line);
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
  if (text.length <= 34) return text;
  const clipped = text.slice(0, 34);
  const atSpace = clipped.lastIndexOf(" ");
  return clipped.slice(0, atSpace > 20 ? atSpace : clipped.length).trim();
}

function polishOverlayLine(value) {
  const text = String(value || "")
    .replace(/\.$/, "")
    .replace(/^Piramida dibangun dari\s+/i, "")
    .replace(/\byang kuat dan tahan lama$/i, "kuat")
    .replace(/^Blok batu disusun dengan presisi tinggi.*$/i, "Susunan batu sangat presisi")
    .replace(/^Desain bentuk segitiga.*$/i, "Bentuk segitiga menahan tekanan")
    .replace(/^Lingkungan gurun yang kering.*$/i, "Cuaca kering ikut mengawetkan")
    .trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function timedCaptionSegments(item, timing) {
  const transcript = Array.isArray(item.assets?.captions) ? item.assets.captions : [];
  const transcriptEvents = transcript
    .filter((entry) => entry.text && Number(entry.end) > Number(entry.start))
    .flatMap((entry) => captionSegments(entry.text, timing.start + Number(entry.start) / timing.tempo, timing.start + Number(entry.end) / timing.tempo));
  if (transcriptEvents.length) return transcriptEvents;

  const text = (item.plan?.scenes || [])
    .map((scene) => String(scene.narration || "").trim())
    .filter(Boolean)
    .join(" ");
  return captionSegments(text, timing.start, timing.start + timing.duration);
}

function captionSegments(text, start, end) {
  const normalizedText = normalizeSubtitleText(text);
  const words = normalizedText.split(/\s+/).filter(Boolean);
  const duration = Math.max(0.1, end - start);
  if (!words.length || duration <= 0.2) return [];

  const chunkSize = 4;
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
      text: splitLines(normalizeSubtitleText(chunk), 28, 2).join("\\N")
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

export async function probeDuration(filePath) {
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
