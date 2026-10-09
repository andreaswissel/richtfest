import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "../../../../richtfest-apps");
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : []; });

describe("Richtfest app boundaries", () => {
  test("apps do not import OS internals or each other", () => {
    for (const file of filesUnder(appRoot)) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["'](?:\.\.\/)+richtfest-os|@richtfest\/(?:api|os)/);
      expect(source).not.toMatch(/from ["']@richtfest\/(?:crm|projects|knowledge)/);
    }
  });
  test("app schemas stay outside OS table namespace", () => {
    for (const file of filesUnder(appRoot).filter((f) => f.endsWith("schema.ts"))) {
      expect(readFileSync(file, "utf8")).not.toMatch(/os_/);
    }
  });
});
