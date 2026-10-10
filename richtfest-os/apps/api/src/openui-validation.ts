import { createParser, type LibraryJSONSchema } from "@openuidev/lang-core";
import {
  openuiRegistrySchema,
  openuiAllowedComponents,
} from "@richtfest/shared/openui-registry";
const parser = createParser(openuiRegistrySchema as LibraryJSONSchema);
export function validateOpenUI(value: unknown, allowedComponents: readonly string[] = openuiAllowedComponents): {
  sourceVersionIds: string[];
  artifactIds: string[];
} {
  if (typeof value !== "string" || value.length > 20000)
    throw new Error("Invalid generated UI");
  const parsed = parser.parse(value);
  if (
    !parsed.root ||
    parsed.meta.incomplete ||
    parsed.meta.unresolved.length ||
    parsed.meta.errors.length ||
    parsed.meta.orphaned.length ||
    parsed.queryStatements.length ||
    parsed.mutationStatements.length ||
    Object.keys(parsed.stateDeclarations).length
  )
    throw new Error("Incomplete or executable generated UI");
  const refs = {
    sourceVersionIds: [] as string[],
    artifactIds: [] as string[],
  };
  function walk(node: any) {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (/https?:|javascript:|data:|<\/?[a-z]/i.test(node))
        throw new Error("External or executable UI content is not allowed");
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (node.type === "element") {
      if (!allowedComponents.includes(node.typeName))
        throw new Error("Unregistered generated UI component");
      if (node.typeName === "SourceCitation")
        refs.sourceVersionIds.push(node.props.versionId);
      if (node.typeName === "ArtifactAction" || node.typeName === "ArtifactPreview")
        refs.artifactIds.push(node.props.artifactId);
    }
    if (node.hasDynamicProps === true || node.partial)
      throw new Error("Dynamic generated UI is disabled");
    if (
      ["action", "query", "mutation", "runtime-expr"].includes(node.type) ||
      node.steps ||
      node.action
    )
      throw new Error("Generated UI actions are disabled");
    Object.values(node).forEach(walk);
  }
  walk(parsed.root);
  return refs;
}
