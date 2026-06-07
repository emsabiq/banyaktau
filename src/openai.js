import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, paths } from "./config.js";
import { safeFilename } from "./util.js";

export async function requestKnowledgeJson(promptText) {
  assertOpenAi();
  const response = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      model: config.openai.storyModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are an Indonesian educational video writer. Write factual, engaging, natural Indonesian narration for encyclopedia-style short or long videos according to the user's requested format. Return valid JSON only."
        },
        { role: "user", content: promptText }
      ],
      temperature: 0.78
    })
  });
  const data = await parseOpenAiResponse(response);
  const content = data.choices?.[0]?.message?.content || "";
  return JSON.parse(content);
}

export async function requestIdeaJson(promptText) {
  assertOpenAi();
  const response = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      model: config.openai.storyModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are an Indonesian short-video ideation producer for a factual knowledge channel. Recommend scroll-stopping, factual, low-cost visual ideas. Return valid JSON only."
        },
        { role: "user", content: promptText }
      ],
      temperature: 0.92
    })
  });
  const data = await parseOpenAiResponse(response);
  const content = data.choices?.[0]?.message?.content || "";
  return JSON.parse(content);
}

export async function generateSceneImage({ itemId, scene, size, quality }) {
  assertOpenAi();
  await fs.mkdir(paths.imageDir, { recursive: true });

  const prompt = sanitizeImagePrompt(scene.imagePrompt, size);
  const response = await fetch(`${config.openai.baseUrl}/images/generations`, {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      model: config.openai.imageModel,
      prompt,
      size,
      quality,
      n: 1
    })
  });
  const data = await parseOpenAiResponse(response);
  const item = data.data?.[0];
  if (!item) throw new Error("OpenAI tidak mengembalikan gambar.");

  const rawFilename = `${itemId}-scene-${scene.index}-${safeFilename(scene.screenText)}-raw.png`;
  const rawPath = path.join(paths.workDir, rawFilename);
  let filename = `${itemId}-scene-${scene.index}-${safeFilename(scene.screenText)}.jpg`;
  let outputPath = path.join(paths.imageDir, filename);
  await fs.mkdir(paths.workDir, { recursive: true });

  if (item.b64_json) {
    await fs.writeFile(rawPath, Buffer.from(item.b64_json, "base64"));
  } else if (item.url) {
    const image = await fetch(item.url);
    if (!image.ok) throw new Error(`Gagal download image: HTTP ${image.status}`);
    await fs.writeFile(rawPath, Buffer.from(await image.arrayBuffer()));
  } else {
    throw new Error("Format response image tidak dikenali.");
  }

  try {
    await optimizeImage(rawPath, outputPath, size);
    await fs.rm(rawPath, { force: true });
  } catch {
    filename = `${itemId}-scene-${scene.index}-${safeFilename(scene.screenText)}.png`;
    outputPath = path.join(paths.imageDir, filename);
    await fs.rename(rawPath, outputPath);
  }

  return {
    sceneIndex: scene.index,
    provider: providerName(),
    path: outputPath,
    url: `/generated/images/${filename}`,
    prompt
  };
}

function optimizeImage(inputPath, outputPath, size = "") {
  let scaleCrop = "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280";
  if (size) {
    const [w, h] = size.split("x").map(Number);
    if (w > h) {
      scaleCrop = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720";
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vf", scaleCrop,
      "-frames:v", "1",
      "-q:v", "7",
      outputPath
    ], { windowsHide: true, cwd: paths.rootDir });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Optimasi gambar gagal (${code})`));
    });
  });
}

export async function generateOpenAiSpeech({ itemId, text, voice, instructions, filenameSuffix = "openai" }) {
  assertOpenAi();
  await fs.mkdir(paths.audioDir, { recursive: true });

  const selectedVoice = voice || config.openai.ttsVoice;
  const filename = `${itemId}-${safeFilename(filenameSuffix)}-narration.mp3`;
  const outputPath = path.join(paths.audioDir, filename);
  const payload = {
    model: config.openai.ttsModel,
    voice: selectedVoice,
    input: text,
    response_format: "mp3"
  };
  if (!/dinoiki/i.test(config.openai.baseUrl)) {
    payload.instructions = instructions || "Bacakan sepenuhnya dalam Bahasa Indonesia natural. Gaya suara hangat, penasaran, jelas, seperti kreator pengetahuan sedang menjelaskan fakta menarik kepada teman. Tempo sedang dan tetap santai; jangan terdengar seperti robot, beri jeda ringan setelah kalimat penting, dan tekankan pertanyaan transisi dengan rasa ingin tahu.";
  }
  const response = await fetch(`${config.openai.baseUrl}/audio/speech`, {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI TTS gagal HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }

  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return {
    provider: providerName(),
    model: config.openai.ttsModel,
    voice: selectedVoice,
    path: outputPath,
    url: `/generated/audio/${filename}`
  };
}

export async function transcribeSpeechSegments(audioPath) {
  assertOpenAi();
  try {
    return await transcribeSpeechSegmentsWithModel(audioPath, config.openai.transcribeModel);
  } catch (error) {
    if (!/verbose_json|response_format|timestamp/i.test(error.message) || config.openai.transcribeModel === "whisper-1") {
      throw error;
    }
    return transcribeSpeechSegmentsWithModel(audioPath, "whisper-1");
  }
}

async function transcribeSpeechSegmentsWithModel(audioPath, model) {
  const buffer = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buffer]), path.basename(audioPath));
  form.append("model", model);
  form.append("language", "id");
  form.append("response_format", "verbose_json");

  const response = await fetch(`${config.openai.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    body: form
  });
  const data = await parseOpenAiResponse(response);
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length) {
    return segments
      .map((segment) => ({
        start: Number(segment.start || 0),
        end: Number(segment.end || 0),
        text: String(segment.text || "").replace(/\s+/g, " ").trim()
      }))
      .filter((segment) => segment.text && segment.end > segment.start);
  }

  const text = String(data.text || "").replace(/\s+/g, " ").trim();
  return text ? [{ start: 0, end: 0, text }] : [];
}

function providerName() {
  return /dinoiki/i.test(config.openai.baseUrl) ? "dinoiki" : "openai";
}

function assertOpenAi() {
  if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY belum diisi.");
}

function headersJson() {
  return {
    Authorization: `Bearer ${config.openai.apiKey}`,
    "Content-Type": "application/json"
  };
}

function sanitizeImagePrompt(value, size = "") {
  let orientation = "vertical 9:16";
  if (size) {
    const [w, h] = size.split("x").map(Number);
    if (w > h) orientation = "horizontal landscape 16:9";
  }
  return [
    String(value || ""),
    `${orientation} editorial knowledge video illustration, Indonesian friendly educational visual style, cinematic but bright, high detail, clear subject, varied composition, no written text inside the image, no logo, no watermark, no celebrity likeness, no gore, no injury`
  ].join(", ");
}

async function parseOpenAiResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}
