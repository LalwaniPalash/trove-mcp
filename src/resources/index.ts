import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../lib/core/context.js";

const SOURCE_CAPABILITIES = {
  openalex: {
    role: "primary metadata/search/citations",
    authRequired: false,
    notes: "Use TROVE_CONTACT_EMAIL for polite usage. Exposes current cited_by_count and yearly counts_by_year, but not day-level citation history.",
  },
  semantic_scholar: {
    role: "semantic similarity and recommendation",
    authRequired: false,
    notes: "Optional SEMANTIC_SCHOLAR_API_KEY is strongly recommended. Recommendations/search work without a key only on a shared unauthenticated pool and are not reliable for production similarity workflows.",
  },
  arxiv: {
    role: "preprint metadata and full-text PDF retrieval",
    authRequired: false,
    notes: "Primary full-text fallback source.",
  },
  unpaywall: {
    role: "OA discovery by DOI",
    authRequired: false,
    notes: "Requires email parameter.",
  },
  pubmed: {
    role: "biomedical indexing",
    authRequired: false,
    notes: "NCBI eutils endpoints.",
  },
  huggingface: {
    role: "paper discovery context only",
    authRequired: false,
    notes: "Official HF endpoints: /api/daily_papers and /api/papers/search. Discovery only; no citation-history data for true short-window trending.",
  },
  core: {
    role: "full text and metadata fallback",
    authRequired: false,
    notes: "Optional CORE_API_KEY. Fallback is best-effort when endpoint/network availability is limited.",
  },
};

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    "version",
    "trove://resources/version",
    {
      description: "Current trove-mcp package version.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "trove://resources/version",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              name: "trove-mcp",
              version: ctx.service.getVersion(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "source-capability-matrix",
    "trove://resources/source-capability-matrix",
    {
      description: "Capability, auth, and role matrix for connected research sources.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "trove://resources/source-capability-matrix",
          mimeType: "application/json",
          text: JSON.stringify(SOURCE_CAPABILITIES, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "schema-reference",
    "trove://resources/schema-reference",
    {
      description: "Shared response envelope schema and core payload conventions.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "trove://resources/schema-reference",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              envelope: {
                status: "ok | partial | error",
                degraded: "boolean",
                warnings: "string[]",
                provenance:
                  "Array<{source, endpoint, timestamp, cached, license, latency_ms}>",
                meta: "{ version }",
                data: "tool-specific payload",
              },
              fullTextAvailability: [
                "full_text",
                "partial_text",
                "abstract_only",
                "unavailable",
              ],
              trendingMode: ["snapshot", "unavailable"],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "cache-health",
    "trove://resources/cache-health",
    {
      description: "Current cache and snapshot health stats from local SQLite store.",
      mimeType: "application/json",
    },
    async () => {
      const cache = ctx.service.getCacheStats();
      const health = ctx.service.getSourceHealth();
      return {
        contents: [
          {
            uri: "trove://resources/cache-health",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                cache: cache.data.stats,
                source_health: health.data.health,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
