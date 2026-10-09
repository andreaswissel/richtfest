import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
// Only the entry and its static imports are on the boot path. Route/OpenUI chunks
// are deliberately lazy and must not be misreported as initial JavaScript.
const manifest: Record<
  string,
  { file: string; isEntry?: boolean; imports?: string[] }
> = JSON.parse(
  await readFile(
    new URL("../dist/.vite/manifest.json", import.meta.url),
    "utf8",
  ),
);
const initial = new Set<string>();
function visit(key: string) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const imported of manifest[key]?.imports || []) visit(imported);
}
for (const [key, value] of Object.entries(manifest))
  if (value.isEntry) visit(key);
let size = 0;
for (const key of initial)
  if (manifest[key].file.endsWith(".js"))
    size += gzipSync(
      await readFile(new URL(`../dist/${manifest[key].file}`, import.meta.url)),
    ).length;
console.log(`Initial JavaScript: ${(size / 1024).toFixed(1)} kB gzip / 350 kB`);
if (size >= 350 * 1024) process.exit(1);
