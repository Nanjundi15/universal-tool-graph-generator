
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
  const graphData = JSON.stringify(graph);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Composio Tool Dependency Graph</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
body { margin:0; font-family:Arial,sans-serif; background:#101827; color:#f8fafc; }
header { padding:20px; background:#172337; }
h2 { margin:0 0 8px; }
.controls { display:flex; gap:10px; padding:15px; flex-wrap:wrap; }
input { padding:12px; width:320px; max-width:80%; border-radius:6px; border:0; }
button { padding:11px 16px; border:0; border-radius:6px; cursor:pointer; }
#network { height:75vh; background:#fff; margin:0 15px 15px; border-radius:8px; }
#status { padding:0 15px 12px; color:#cbd5e1; }
</style>
</head>
<body>
<header>
<h2>Composio Tool Dependency Graph</h2>
<div id="stats"></div>
</header>
<div class="controls">
<input id="search" placeholder="Search tool slug..." />
<button onclick="showAll()">Show overview</button>
<button onclick="resetGraph()">Reset</button>
</div>
<div id="status">Search for a tool or select a node to explore its dependencies.</div>
<div id="network"></div>

<script>
const graph = ${graphData};
const allNodes = new vis.DataSet(
  graph.nodes.map(n => ({
    id:n.id,
    label:n.id,
    title:n.id,
    color:{background:'#dbeafe',border:'#2563eb'}
  }))
);
const allEdges = new vis.DataSet(
  graph.edges.map((e,i) => ({
    id:i,
    from:e.from,
    to:e.to,
    label:e.label,
    arrows:'to',
    color:{color:'#94a3b8'},
    font:{size:10,align:'middle'}
  }))
);
const container = document.getElementById('network');
const data = {nodes:new vis.DataSet([]),edges:new vis.DataSet([])};
const options = {
  physics:{stabilization:{iterations:150}},
  interaction:{hover:true,navigationButtons:true,keyboard:true},
  nodes:{shape:'box',margin:10,font:{size:12}},
  edges:{smooth:{type:'dynamic'}}
};
const network = new vis.Network(container,data,options);

document.getElementById('stats').textContent =
  graph.nodes.length + ' tools · ' + graph.edges.length + ' dependencies';

function showNode(id) {
  const connected = graph.edges.filter(e => e.from === id || e.to === id);
  const ids = new Set([id]);
  connected.forEach(e => { ids.add(e.from); ids.add(e.to); });

  data.nodes.clear();
  data.edges.clear();
  data.nodes.add([...ids].map(nodeId => ({
    id:nodeId,
    label:nodeId,
    color:nodeId===id
      ? {background:'#bbf7d0',border:'#16a34a'}
      : {background:'#dbeafe',border:'#2563eb'}
  })));
  data.edges.add(connected.map((e,i) => ({
    id:i,from:e.from,to:e.to,label:e.label,
    arrows:'to',font:{size:11,align:'middle'}
  })));

  document.getElementById('status').textContent =
    id + ' · ' + connected.length + ' direct dependencies';
  network.fit();
}

function showAll() {
  data.nodes.clear();
  data.edges.clear();
  data.nodes.add(allNodes.get());
  data.edges.add(allEdges.get());
  document.getElementById('status').textContent =
    'Full graph overview · select a node to inspect its connections.';
  network.fit();
}

function resetGraph() {
  document.getElementById('search').value='';
  showAll();
}

network.on('click', params => {
  if(params.nodes.length) showNode(params.nodes[0]);
});

document.getElementById('search').addEventListener('input', event => {
  const query=event.target.value.toLowerCase().trim();
  if(!query) { showAll(); return; }
  const match=graph.nodes.find(n=>n.id.toLowerCase().includes(query));
  if(match) showNode(match.id);
});

showAll();
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
