// Worked example: a scoping-stage literature review run through Trove over MCP.
//
// It starts the built server as a real MCP client would, calls six tools in the
// order a researcher would use them, and saves every response envelope to
// examples/output/<slug>/ so the status, warnings and provenance can be inspected.
//
//   npm run build
//   npx tsx examples/literature-review.ts "transboundary environmental harm international law"

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Envelope = {
  status: string;
  degraded: boolean;
  warnings: string[];
  provenance: Array<{ source: string }>;
  data: any;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const query = process.argv[2] ?? "transboundary environmental harm international law";
const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = path.join(here, "output", slug);
mkdirSync(outDir, { recursive: true });

// A fresh database makes the run reproducible: nothing is served from an older cache,
// and get_trending_papers shows its cold-start behaviour.
const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "trove-example-")), "trove.db");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.TROVE_DB_PATH = dbPath;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "dist", "index.js")],
  env,
});
const client = new Client({ name: "trove-example", version: "1.0.0" });

let step = 0;
async function call(tool: string, args: Record<string, unknown>): Promise<Envelope | null> {
  step += 1;
  // Live provider calls can exceed the SDK's 60-second default, especially full-text fetches.
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
  const file = path.join(outDir, `${String(step).padStart(2, "0")}-${tool}.json`);

  let envelope: Envelope | null = null;
  try {
    envelope = JSON.parse(text) as Envelope;
  } catch {
    // Tool-level errors come back as plain text, not as an envelope.
  }
  writeFileSync(file, envelope ? JSON.stringify({ arguments: args, response: envelope }, null, 2) : JSON.stringify({ arguments: args, error: text }, null, 2));

  if (envelope) {
    const sources = [...new Set(envelope.provenance.map((p) => p.source))].join(", ") || "none";
    console.log(`${step}. ${tool}: status=${envelope.status} degraded=${envelope.degraded} warnings=${envelope.warnings.length} sources=[${sources}]`);
  } else {
    console.log(`${step}. ${tool}: refused -> ${text.slice(0, 120)}`);
  }
  return envelope;
}

await client.connect(transport);
try {
  // 1. Find candidate literature.
  const search = await call("search_papers", { query, filters: { limit: 10 } });
  const results: Array<{ paper: { id: string; title: string; openAccess?: boolean } }> = search?.data?.results ?? [];
  if (!results.length) {
    throw new Error("search_papers returned no results; try a broader query.");
  }
  const top = results[0].paper;
  const openPaper = results.find((r) => r.paper.openAccess)?.paper ?? top;

  // 2. Resolve the top result to its canonical record with every known identifier.
  await call("get_paper", { identifier: top.id });

  // 3. Read the first open-access result through the legal full-text chain.
  await call("get_full_text", { identifier: openPaper.id });

  // 4. Build an extractive evidence map: claims, methods and limitations, each tied to a paper ID.
  await call("build_literature_map", { query, depth: 1 });

  // 5. On a fresh database, trending must report `unavailable` instead of ranking by total citations.
  await call("get_trending_papers", { topic: query, days_back: 30 });

  // 6. Without SEMANTIC_SCHOLAR_API_KEY, similarity must refuse instead of falling back to keyword overlap.
  await call("find_similar_papers", { paper_id: top.id, limit: 5 });

  console.log(`\nSaved ${step} responses to ${path.relative(process.cwd(), outDir)}`);
} finally {
  await client.close();
}
