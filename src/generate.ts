
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Schema = Record<string, any>;
type Tool = Record<string, any>;

interface Node {
  id: string;
}

interface Edge {
  from: string;
  to: string;
  label: string;
}

interface Graph {
  nodes: Node[];
  edges: Edge[];
}

const catalogPath = process.argv[process.argv.length - 1];

const outputPath = resolve(process.cwd(), "dependency_graph.json");

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// Resolve JSON Schema references.
function resolveRef(schema: Schema, root: Schema): Schema {
  if (!schema?.$ref) return schema;

  const path = schema.$ref.replace(/^#\//, "").split("/");
  let current: any = root;

  for (const part of path) {
    current = current?.[
      part.replace(/~1/g, "/").replace(/~0/g, "~")
    ];
  }

  return current ?? {};
}

// Keep fields that can represent actionable resource identifiers.
const DEPENDENCY_FIELDS = new Set([
  "number",
  "issue_number",
  "issue_id",
  "pull_number",
  "pull_id",
  "pull_request_number",
  "pull_request_id",
  "repository_id",
  "repository_node_id",
  "migration_id",
  "workflow_id",
  "run_id",
  "run_number",
  "commit_id",
  "commit_sha",
  "head_sha",
  "base_sha",
  "sha",
  "branch",
  "branch_name",
  "ref",
  "release_id",
  "release_tag",
  "comment_id",
  "review_id",
  "check_run_id",
  "deployment_id",
  "environment_id",
  "project_id",
  "project_number",
  "discussion_id",
  "package_id",
  "artifact_id",
  "installation_id",
  "team_id",
  "user_id",
  "milestone_id",
  "invitation_id",
  "hook_id",
  "webhook_id",
  "organization_id",
  "org_id",
  "asset_id",
  "tag_name",
  "node_id",
  "database_id"
]);

function isDependencyField(field: string): boolean {
  return DEPENDENCY_FIELDS.has(normalize(field));
}

// Extract required inputs, falling back to optional inputs when needed.
function getInputFields(tool: Tool): string[] {
  const schema = tool.inputParameters ?? {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  const candidates = required.length
    ? required.filter((field: string) => properties[field])
    : Object.keys(properties);

  return candidates.filter(isDependencyField);
}

// Recursively extract useful output fields, including nested objects and refs.
function getOutputFields(tool: Tool): string[] {
  const root = tool.outputParameters ?? {};
  const fields = new Set<string>();
  const visited = new Set<Schema>();

  function walk(schema: Schema, depth = 0): void {
    if (!schema || typeof schema !== "object" || depth > 10) {
      return;
    }

    const resolved = resolveRef(schema, root);

    if (visited.has(resolved)) return;

    visited.add(resolved);

    const properties = resolved.properties ?? {};

    for (const [name, child] of Object.entries(properties)) {
      if (isDependencyField(name)) {
        fields.add(normalize(name));
      }

      walk(child as Schema, depth + 1);
    }

    if (resolved.items) {
      walk(resolved.items, depth + 1);
    }

    for (const option of [
      ...(resolved.anyOf ?? []),
      ...(resolved.oneOf ?? []),
      ...(resolved.allOf ?? [])
    ]) {
      walk(option, depth + 1);
    }
  }

  walk(root);

  return [...fields];
}

// Normalize alternative field names into common resource identifiers.
function semanticKey(field: string, tool: Tool): string {
  const key = normalize(field);
  const compact = key.replace(/_/g, "");

  const aliases: Record<string, string> = {
    issuenumber: "issue_number",
    issueid: "issue_id",
    pullnumber: "pull_number",
    pullrequestnumber: "pull_number",
    pullrequestid: "pull_id",
    pullid: "pull_id",
    repositoryid: "repository_id",
    migrationid: "migration_id",
    branchname: "branch",
    commitsha: "sha",
    commitid: "sha",
    runid: "run_id",
    workflowid: "workflow_id",
    releaseid: "release_id",
    commentid: "comment_id",
    reviewid: "review_id"
  };

  if (aliases[compact]) {
    return aliases[compact];
  }

  // Contextual handling of generic number fields.
  if (key === "number") {
  const context = normalize(
    `${tool.slug ?? ""} ${tool.name ?? ""} ${tool.description ?? ""}`
  );

  const slug = normalize(tool.slug ?? "");

  if (slug.includes("list_repository_issues") || slug.includes("issue")) {
    return "issue_number";
  }

  if (slug.includes("pull_request") || slug.includes("pullrequest")) {
    return "pull_number";
  }

  if (/issue|comment/.test(context)) {
    return "issue_number";
  }

  if (/pull|merge.*request/.test(context)) {
    return "pull_number";
  }
}

  return key;
}

// Generate the dependency graph from the supplied catalog.
function generate(tools: Tool[]): Graph {
  const validTools = tools.filter(
    (tool) =>
      typeof tool.slug === "string" &&
      tool.slug.trim().length > 0
  );

  const nodes: Node[] = validTools.map((tool) => ({
    id: tool.slug
  }));

  const outputIndex = validTools.map((tool) => ({
    slug: tool.slug,
    tool,
    fields: getOutputFields(tool)
  }));

  const edges: Edge[] = [];
  const edgeSet = new Set<string>();

  for (const consumer of validTools) {
    const inputs = getInputFields(consumer);

    for (const input of inputs) {
      const requiredKey = semanticKey(input, consumer);

      for (const producer of outputIndex) {
        if (producer.slug === consumer.slug) continue;

        const matched = producer.fields.some(
          (field) =>
            semanticKey(field, producer.tool) === requiredKey
        );

        if (!matched) continue;

        const edgeKey =
          `${producer.slug}|${consumer.slug}|${input}`;

        if (edgeSet.has(edgeKey)) continue;

        edgeSet.add(edgeKey);

        edges.push({
          from: producer.slug,
          to: consumer.slug,
          label: input
        });
      }
    }
  }

  return { nodes, edges };
}

// Create a browser-based visualization.
function createVisualization(graph: Graph): string {
  const mermaid = [
    "flowchart LR",

    ...graph.nodes.map(
      (node, i) => `N${i}["${node.id}"]`
    ),

    ...graph.edges.map((edge) => {
      const from = graph.nodes.findIndex(
        (node) => node.id === edge.from
      );

      const to = graph.nodes.findIndex(
        (node) => node.id === edge.to
      );

      return `N${from} -->|"${edge.label}"| N${to}`;
    })
  ].join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tool Dependency Graph</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
<style>
body {
  font-family: Arial, sans-serif;
  margin: 30px;
  background: #f8fafc;
}
h1 { color: #172554; }
#graph {
  background: white;
  padding: 24px;
  border-radius: 12px;
  overflow: auto;
}
</style>
</head>
<body>
<h1>Composio Tool Dependency Graph</h1>
<p>${graph.nodes.length} tools · ${graph.edges.length} dependencies</p>
<div id="graph">
<pre class="mermaid">
${mermaid}
</pre>
</div>
<script>
mermaid.initialize({startOnLoad:true,theme:"neutral"});
</script>
</body>
</html>`;
}

function main(): void {
  if (!catalogPath || catalogPath === "src/generate.ts") {
    throw new Error(
      "Usage: npm run generate -- path/to/catalog.json"
    );
  }

  const absolutePath = resolve(process.cwd(), catalogPath);

  const data = JSON.parse(
    readFileSync(absolutePath, "utf8")
  );

  const tools: Tool[] = Array.isArray(data)
    ? data
    : data.tools ?? data.items ?? [];

  if (!tools.length) {
    throw new Error("No tools found in the supplied catalog.");
  }

  const graph = generate(tools);

  writeFileSync(
    outputPath,
    JSON.stringify(graph, null, 2),
    "utf8"
  );

  writeFileSync(
    resolve(process.cwd(), "visualization.html"),
    createVisualization(graph),
    "utf8"
  );

  console.log(`Generated ${graph.nodes.length} nodes.`);
  console.log(`Generated ${graph.edges.length} dependency edges.`);
  console.log("Files: dependency_graph.json, visualization.html");
}

main();
