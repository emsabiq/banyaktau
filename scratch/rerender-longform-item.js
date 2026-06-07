import { renderLongformVideo } from "../src/longform-render.js";
import { getItem, saveItem } from "../src/storage.js";

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const id = argValue("--id");
if (!id) throw new Error("Gunakan --id=<item-id>.");

const item = await getItem(id);
if (!item) throw new Error(`Item ${id} tidak ditemukan.`);

item.assets.video = await renderLongformVideo(item);
item.status = "rendered";
item.updatedAt = new Date().toISOString();
await saveItem(item);

console.log(JSON.stringify(item.assets.video, null, 2));
