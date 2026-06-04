import fs from "node:fs";
import path from "node:path";

function patchFile(filePath, searchStr, replaceStr) {
  if (!fs.existsSync(filePath)) {
    console.log(`[WARNING] File not found: ${filePath}`);
    return false;
  }
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(replaceStr)) {
    console.log(`[OK] Already patched or replacement already present in ${filePath}`);
    return true;
  }
  if (!content.includes(searchStr)) {
    // Try normalizing CRLF to LF in search and content
    const normalizedContent = content.replace(/\r\n/g, "\n");
    const normalizedSearch = searchStr.replace(/\r\n/g, "\n");
    if (normalizedContent.includes(normalizedSearch)) {
      const normalizedReplace = replaceStr.replace(/\r\n/g, "\n");
      fs.writeFileSync(filePath, normalizedContent.replace(normalizedSearch, normalizedReplace), "utf8");
      console.log(`[SUCCESS] Patched normalized content in ${filePath}`);
      return true;
    }
    console.log(`[ERROR] Search string not found in ${filePath}`);
    return false;
  }
  fs.writeFileSync(filePath, content.replace(searchStr, replaceStr), "utf8");
  console.log(`[SUCCESS] Patched ${filePath}`);
  return true;
}

// 1. Patch dist/text.js
const textJsPath = "node_modules/pureimage/dist/text.js";
const textJsSearch = `    const path = font.font.getPath(text, x, y, size);
    ctx.beginPath();
    path.commands.forEach(function (cmd) {
        switch (cmd.type) {
            case "M":
                ctx.moveTo(cmd.x, cmd.y);
                break;
            case "Q":
                ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
                break;
            case "L":
                ctx.lineTo(cmd.x, cmd.y);
                break;
            case "C":
                ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
                break;
            case "Z": {
                ctx.closePath();
                fill ? ctx.fill() : ctx.stroke();
                ctx.beginPath();
                break;
            }
        }
    });`;

const textJsReplace = `    const path = font.font.getPath(text, x, y, size);
    ctx.beginPath();
    path.commands.forEach(function (cmd) {
        switch (cmd.type) {
            case "M":
                ctx.moveTo(cmd.x, cmd.y);
                break;
            case "Q":
                ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
                break;
            case "L":
                ctx.lineTo(cmd.x, cmd.y);
                break;
            case "C":
                ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
                break;
            case "Z": {
                ctx.closePath();
                break;
            }
        }
    });
    fill ? ctx.fill() : ctx.stroke();`;

patchFile(textJsPath, textJsSearch, textJsReplace);

// 2. Patch dist/index.esm.js
const esmJsPath = "node_modules/pureimage/dist/index.esm.js";
const esmJsSearch = `s.beginPath(),l.commands.forEach(function(h){switch(h.type){case"M":s.moveTo(h.x,h.y);break;case"Q":s.quadraticCurveTo(h.x1,h.y1,h.x,h.y);break;case"L":s.lineTo(h.x,h.y);break;case"C":s.bezierCurveTo(h.x1,h.y1,h.x2,h.y2,h.x,h.y);break;case"Z":{s.closePath(),o?s.fill():s.stroke(),s.beginPath();break}}})`;
const esmJsReplace = `s.beginPath(),l.commands.forEach(function(h){switch(h.type){case"M":s.moveTo(h.x,h.y);break;case"Q":s.quadraticCurveTo(h.x1,h.y1,h.x,h.y);break;case"L":s.lineTo(h.x,h.y);break;case"C":s.bezierCurveTo(h.x1,h.y1,h.x2,h.y2,h.x,h.y);break;case"Z":{s.closePath();break}}}),o?s.fill():s.stroke()`;

patchFile(esmJsPath, esmJsSearch, esmJsReplace);

// 3. Patch dist/index.cjs
const cjsJsPath = "node_modules/pureimage/dist/index.cjs";
const cjsJsSearch = `t.beginPath(),u.commands.forEach(function(c){switch(c.type){case"M":t.moveTo(c.x,c.y);break;case"Q":t.quadraticCurveTo(c.x1,c.y1,c.x,c.y);break;case"L":t.lineTo(c.x,c.y);break;case"C":t.bezierCurveTo(c.x1,c.y1,c.x2,c.y2,c.x,c.y);break;case"Z":{t.closePath(),a?t.fill():t.stroke(),t.beginPath();break}}})`;
const cjsJsReplace = `t.beginPath(),u.commands.forEach(function(c){switch(c.type){case"M":t.moveTo(c.x,c.y);break;case"Q":t.quadraticCurveTo(c.x1,c.y1,c.x,c.y);break;case"L":t.lineTo(c.x,c.y);break;case"C":t.bezierCurveTo(c.x1,c.y1,c.x2,c.y2,c.x,c.y);break;case"Z":{t.closePath();break}}}),a?t.fill():t.stroke()`;

patchFile(cjsJsPath, cjsJsSearch, cjsJsReplace);
