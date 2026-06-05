import fs from "node:fs";

const content = fs.readFileSync("node_modules/pureimage/dist/index.esm.js", "utf8");
console.log("ESM length:", content.length);

const regex = /getPath\([^)]+\)/;
const match = content.match(regex);
if (match) {
  console.log("Found getPath match at index:", match.index);
  console.log("Snippet:", content.substring(match.index - 200, match.index + 800));
} else {
  const forEachIdx = content.indexOf("commands.forEach");
  console.log("commands.forEach index:", forEachIdx);
  if (forEachIdx !== -1) {
    console.log("Snippet:", content.substring(forEachIdx - 200, forEachIdx + 600));
  }
}
