import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer, disabledTools: string[] = []): void {
  const disabled = new Set(disabledTools.map((name) => name.trim().toLowerCase()));
  const hasTools = (required: string[]) => required.every((name) => !disabled.has(name.toLowerCase()));

  if (hasTools(["search_papers", "build_literature_map", "get_full_text"])) {
  server.prompt(
    "literature-review-workflow",
    "Use Trove tools to create a structured literature review with evidence mapping.",
    {
      query: z.string().describe("Research question or topic."),
      depth: z.number().int().min(1).max(5).default(2).describe("Map depth for build_literature_map."),
    },
    ({ query, depth }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are performing an evidence-first literature review.",
              `Query: ${query}`,
              `Depth: ${depth}`,
              "1) Call search_papers to gather baseline works.",
              "2) Call build_literature_map to extract claims, methods, limitations, consensus, and contradictions.",
              "3) For key papers with high influence, call get_full_text as needed.",
              "4) Present a structured overview with explicit evidence references and open questions.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  }

  if (hasTools(["compare_papers"])) {
  server.prompt(
    "paper-comparison-workflow",
    "Compare 2-5 papers with methodological and evidence-focused structure.",
    {
      paper_ids: z.array(z.string()).min(2).max(5).describe("Paper IDs to compare."),
    },
    ({ paper_ids }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are conducting a structured paper comparison.",
              `Paper IDs: ${paper_ids.join(", ")}`,
              "1) Call compare_papers with all IDs.",
              "2) For uncertain fields, call get_paper or get_full_text for specific IDs.",
              "3) Return a matrix covering methodology, findings, limitations, reproducibility, and confidence.",
              "4) Clearly separate facts from inferences.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  }

  if (hasTools(["trace_idea", "get_paper", "get_references", "get_citations"])) {
  server.prompt(
    "idea-lineage-workflow",
    "Trace concept evolution and identify seminal branching papers.",
    {
      concept: z.string().describe("Concept to trace."),
      from_year: z.number().int().optional().describe("Optional lower year bound."),
    },
    ({ concept, from_year }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are tracing the evolution of an academic idea.",
              `Concept: ${concept}`,
              from_year ? `From year: ${from_year}` : "From year: not constrained",
              "1) Call trace_idea to get origin candidates and timeline.",
              "2) Validate key nodes with get_paper, get_references, and get_citations.",
              "3) Produce a chronological narrative with turning points and unresolved debates.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  }
}
