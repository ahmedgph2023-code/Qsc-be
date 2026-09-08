import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readAsWindows1256ThenUtf8(file) {
  const buf = fs.readFileSync(file);
  const asUtf8 = buf.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) {
    return { text: asUtf8, encoding: "utf8" };
  }
  const text = new TextDecoder("windows-1256").decode(buf);
  return { text, encoding: "windows-1256" };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [
  path.resolve(here, "../samples/BroadcastData.json"),
  path.resolve(here, "../../meeting/meeting_3/BroadcastData.json"),
];

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log("skip missing", file);
    continue;
  }
  const { text, encoding } = readAsWindows1256ThenUtf8(file);
  JSON.parse(text); // validate
  if (encoding === "utf8") {
    console.log("already utf8", file);
    continue;
  }
  fs.writeFileSync(file, text, "utf8");
  console.log("converted", encoding, "→ utf8", file);
}
