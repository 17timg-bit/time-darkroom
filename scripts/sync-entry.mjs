import { readFileSync, writeFileSync } from "node:fs";

const localEntry = new URL("../打开时间暗房.html", import.meta.url);
const onlineEntry = new URL("../index.html", import.meta.url);
const expected = readFileSync(localEntry, "utf8").replace(/\r\n/g, "\n");

if (process.argv.includes("--check")) {
  if (readFileSync(onlineEntry, "utf8") !== expected) {
    throw new Error("Run node scripts/sync-entry.mjs to synchronize index.html.");
  }
} else {
  writeFileSync(onlineEntry, expected);
}
