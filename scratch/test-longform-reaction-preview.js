import { createLongformDraft } from "../src/longform-story-engine.js";
import { ensureLongformSceneAudio } from "../src/pipeline.js";
import { renderLongformVideo } from "../src/longform-render.js";
import { getItem, saveItem } from "../src/storage.js";

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const sourceId = argValue("--source", "tau-lf_f136da3a32eb");
const source = await getItem(sourceId);
if (!source) throw new Error(`Item sumber ${sourceId} tidak ditemukan.`);

const item = await createLongformDraft({
  topic: source.input?.topic || source.title,
  category: source.input?.category || "sejarah",
  durationSec: 300,
  sceneCount: 14,
  ttsProvider: "openai"
});

item.assets.images = [...(source.assets?.images || [])];
item.assets.clips = [...(source.assets?.clips || [])];

await ensureLongformSceneAudio(item, {
  provider: "openai",
  voice: "cedar",
  instructions: [
    "Bacakan dalam Bahasa Indonesia dengan suara laki-laki yang natural, hangat, dan percaya diri.",
    "Gaya dokumenter santai, bukan suara iklan dan bukan membaca teks secara kaku.",
    "Gunakan tempo sedang dan variasikan intonasi.",
    "Gunakan jeda ringan hanya pada tanda baca dan pergantian paragraf."
  ].join(" "),
  strict: true
});

await saveItem(item);
item.assets.video = await renderLongformVideo(item);
item.status = "rendered";
item.updatedAt = new Date().toISOString();
await saveItem(item);

console.log(JSON.stringify({
  id: item.id,
  storyboard: item.assets.storyboard,
  video: item.assets.video,
  reactionScenes: item.plan.scenes
    .filter((scene) => scene.sceneType === "reaction")
    .map((scene) => ({
      index: scene.index,
      text: scene.screenText
    }))
}, null, 2));
