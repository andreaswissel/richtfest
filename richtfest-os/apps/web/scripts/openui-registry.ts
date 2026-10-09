import {
  library,
  systemPrompt,
} from "../src/components/project-workspace/openui";
const schema = library.toJSONSchema();
const output = `// Generated from the registered Richtfest web components. Run web/scripts/openui-registry.ts.\nexport const openuiRegistrySchema = ${JSON.stringify(schema, null, 2)};\nexport const openuiRegistryPrompt = ${JSON.stringify(systemPrompt)};\nexport const openuiAllowedComponents = ${JSON.stringify(Object.keys(schema.$defs || {}))};\n`;
const path = new URL(
  "../../../../richtfest-shared/src/openui-registry.generated.ts",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  if ((await Bun.file(path).text()) !== output)
    throw new Error(
      "OpenUI registry snapshot is stale. Regenerate the trusted server schema.",
    );
  console.log("OpenUI registry snapshot matches.");
} else await Bun.write(path, output);
