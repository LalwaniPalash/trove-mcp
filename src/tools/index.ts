import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../lib/core/context.js";
import { envelopeToText, getDefaultEnvelopeMeta } from "../lib/core/envelope.js";
import { toErrorMessage } from "../lib/core/errors.js";
import type { SearchFilters } from "../lib/types/common.js";

const FiltersSchema = z.object({
  year_min: z.number().int().optional().describe("Minimum publication year."),
  year_max: z.number().int().optional().describe("Maximum publication year."),
  field: z.string().optional().describe("Field constraint."),
  topic: z.string().optional().describe("Topic keyword."),
  open_access_only: z.boolean().optional().describe("Restrict to open-access papers."),
  citation_min: z.number().int().optional().describe("Minimum citation count."),
  institution: z.string().optional().describe("Institution filter."),
  author: z.string().optional().describe("Author filter."),
  limit: z.number().int().min(1).max(100).optional().describe("Result limit."),
});

function parseFilters(filters: unknown): SearchFilters {
  return (filters ?? {}) as SearchFilters;
}

function toolError(error: unknown) {
  const payload = {
    status: "error",
    degraded: true,
    warnings: [toErrorMessage(error)],
    provenance: [],
    meta: getDefaultEnvelopeMeta(),
    data: null,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export function registerTools(server: McpServer, ctx: AppContext, disabledTools: string[] = []): void {
  const disabled = new Set(disabledTools.map((name) => name.trim().toLowerCase()));
  const register = ((name: string, config: unknown, handler: unknown) => {
    if (disabled.has(name.toLowerCase())) {
      return;
    }
    (server.registerTool as (...args: unknown[]) => void)(name, config, handler);
  }) as McpServer["registerTool"];

  register(
    "search_papers",
    {
      title: "Search Papers",
      description:
        "Search papers across OpenAlex, Semantic Scholar, arXiv, PubMed, and CORE.",
      inputSchema: {
        query: z.string().min(1).describe("The paper search query."),
        filters: FiltersSchema.optional().describe("Optional normalized filters."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ query, filters }) => {
      try {
        const envelope = await ctx.service.searchPapers(query, parseFilters(filters));
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_trending_papers",
    {
      title: "Get Trending Papers",
      description: "Find papers with high recent citation velocity for a topic using local citation snapshot history. First-run unavailable is expected until multiple snapshot dates exist.",
      inputSchema: {
        topic: z.string().min(1).describe("Topic to evaluate."),
        days_back: z.number().int().min(1).max(365).default(30).describe("Lookback window in days."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ topic, days_back }) => {
      try {
        const envelope = await ctx.service.getTrendingPapers(topic, days_back);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_paper",
    {
      title: "Get Paper",
      description:
        "Resolve a paper by DOI, arXiv ID, Semantic Scholar ID, OpenAlex ID, PubMed ID, or title.",
      inputSchema: {
        identifier: z.string().min(1).describe("DOI/arXiv/S2/OpenAlex/PubMed ID or title."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier }) => {
      try {
        const envelope = await ctx.service.getPaper(identifier);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_full_text",
    {
      title: "Get Full Text",
      description: "Retrieve full text with fallback order arXiv -> Unpaywall -> CORE.",
      inputSchema: {
        identifier: z.string().min(1).describe("Paper identifier."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier }) => {
      try {
        const envelope = await ctx.service.getFullText(identifier);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_citations",
    {
      title: "Get Citations",
      description: "List papers that cite a given paper.",
      inputSchema: {
        paper_id: z.string().min(1).describe("Paper identifier."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max citation results."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ paper_id, limit }) => {
      try {
        const envelope = await ctx.service.getCitations(paper_id, limit);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_references",
    {
      title: "Get References",
      description: "List papers referenced by a given paper.",
      inputSchema: {
        paper_id: z.string().min(1).describe("Paper identifier."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max reference results."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ paper_id, limit }) => {
      try {
        const envelope = await ctx.service.getReferences(paper_id, limit);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "find_similar_papers",
    {
      title: "Find Similar Papers",
      description: "Find semantically similar papers via Semantic Scholar recommendations. Reliable use requires SEMANTIC_SCHOLAR_API_KEY.",
      inputSchema: {
        paper_id: z.string().min(1).describe("Paper identifier."),
        limit: z.number().int().min(1).max(50).default(20).describe("Recommendation limit."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ paper_id, limit }) => {
      try {
        const envelope = await ctx.service.findSimilarPapers(paper_id, limit);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_author",
    {
      title: "Get Author",
      description: "Get author profile and impact metrics. mostCitedPaperIds and recentPaperIds are best-effort enrichment fields.",
      inputSchema: {
        identifier: z.string().min(1).describe("Author name or provider ID."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier }) => {
      try {
        const envelope = await ctx.service.getAuthor(identifier);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_institution_output",
    {
      title: "Get Institution Output",
      description: "Return institution profile and papers from that institution.",
      inputSchema: {
        institution: z.string().min(1).describe("Institution name."),
        filters: FiltersSchema.optional().describe("Optional normalized filters."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ institution, filters }) => {
      try {
        const envelope = await ctx.service.getInstitutionOutput(institution, parseFilters(filters));
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "get_coauthor_network",
    {
      title: "Get Coauthor Network",
      description: "Build a coauthor collaboration graph around an author.",
      inputSchema: {
        author_id: z.string().min(1).describe("Author identifier or name."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ author_id }) => {
      try {
        const envelope = await ctx.service.getCoauthorNetwork(author_id);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "build_literature_map",
    {
      title: "Build Literature Map",
      description:
        "Construct a structured literature map with claims, methods, limitations, consensus and contradictions.",
      inputSchema: {
        query: z.string().min(1).describe("Research question or topic."),
        depth: z.number().int().min(1).max(5).default(2).describe("Depth level."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ query, depth }) => {
      try {
        const envelope = await ctx.service.buildLiteratureMap(query, depth);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "compare_papers",
    {
      title: "Compare Papers",
      description:
        "Compare 2-5 papers on methodology, findings, limitations, and reproducibility signals.",
      inputSchema: {
        paper_ids: z.array(z.string()).min(2).max(5).describe("Paper IDs to compare."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ paper_ids }) => {
      try {
        const envelope = await ctx.service.comparePapers(paper_ids);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  register(
    "trace_idea",
    {
      title: "Trace Idea",
      description: "Trace the historical development of a concept through paper lineage.",
      inputSchema: {
        concept: z.string().min(1).describe("Concept or idea to trace."),
        from_year: z.number().int().optional().describe("Optional lower year bound."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ concept, from_year }) => {
      try {
        const envelope = await ctx.service.traceIdea(concept, from_year);
        return { content: [{ type: "text", text: envelopeToText(envelope) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
