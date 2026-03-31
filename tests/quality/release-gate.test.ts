import { describe, expect, it, vi } from "vitest";
import { setDefaultEnvelopeMeta } from "../../src/lib/core/envelope.js";
import { ResearchService } from "../../src/lib/core/research-service.js";
import { registerResources } from "../../src/resources/index.js";
import { registerTools } from "../../src/tools/index.js";
import type { CanonicalPaper, Envelope } from "../../src/lib/types/common.js";

const testMeta = { version: "0.1.9" };

const canonicalPaper: CanonicalPaper = {
  id: "doi:10.1/base",
  title: "Attention Is All You Need",
  abstract: "We propose the Transformer architecture and show strong translation performance.",
  year: 2017,
  venue: "NeurIPS",
  doi: "10.1/base",
  arxivId: "1706.03762",
  pubmedId: undefined,
  s2Id: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
  openAlexId: "W1514731200",
  url: "https://openalex.org/W1514731200",
  pdfUrl: "https://arxiv.org/pdf/1706.03762.pdf",
  citationCount: 100000,
  referenceCount: 30,
  authors: [{ name: "A. Vaswani" }],
  institutions: ["Google Research"],
  topics: ["transformer", "attention"],
  fields: ["computer science"],
  openAccess: true,
  sourcePriority: ["openalex"],
};

function createService() {
  setDefaultEnvelopeMeta(testMeta);
  const repo = {
    getCache: vi.fn(() => null),
    setCache: vi.fn(),
    upsertPaper: vi.fn(),
    getPaperByCanonicalId: vi.fn(() => null),
    getCitationVelocity: vi.fn(() => 0),
    getCitationSnapshotCount: vi.fn(() => 0),
    saveCitationSnapshot: vi.fn(),
    markSourceOk: vi.fn(),
    markSourceError: vi.fn(),
    getPaperByIdentifier: vi.fn(() => null),
    getAuthor: vi.fn(() => null),
    upsertAuthor: vi.fn(),
    upsertFullText: vi.fn(),
    getFullText: vi.fn(() => null),
    deleteFullText: vi.fn(),
    deleteFullTextMany: vi.fn(() => 0),
    getFullTextEntries: vi.fn(() => []),
  };
  const logger = { warn: vi.fn() };
  const openAlex = {
    searchPapers: vi.fn(async () => ({ papers: [canonicalPaper], warnings: [] })),
    getReferences: vi.fn(async () => []),
    getPaperByIdentifier: vi.fn(async () => canonicalPaper),
    getAuthorWorksById: vi.fn(async () => []),
    getAuthor: vi.fn(async () => null),
  };
  const semantic = {
    searchPapers: vi.fn(async () => ({ papers: [], warnings: [] })),
    findSimilarPapers: vi.fn(async () => []),
    getReferences: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
    getAuthor: vi.fn(async () => null),
    hasApiKeyConfigured: vi.fn(() => false),
    reliableRecommendationsWarning: vi.fn(
      () => "Semantic similarity requires SEMANTIC_SCHOLAR_API_KEY for reliable Semantic Scholar recommendations.",
    ),
  };
  const huggingFace = {
    searchPapers: vi.fn(async () => []),
  };

  const service = new ResearchService(
    repo as never,
    logger as never,
    {} as never,
    "0.1.9",
    openAlex as never,
    semantic as never,
    { searchPapers: vi.fn(async () => []) } as never,
    { isConfigured: vi.fn(() => false), getByDoi: vi.fn(async () => null) } as never,
    { searchPapers: vi.fn(async () => []) } as never,
    { searchPapers: vi.fn(async () => []), findPdfByDoi: vi.fn(async () => null) } as never,
    huggingFace as never,
  );

  return { service, repo, openAlex, semantic, huggingFace };
}

describe("release quality gate", () => {
  it("blocks pseudo-trending when velocity is missing", async () => {
    const { service } = createService();
    const result = await service.getTrendingPapers("transformer", 30);
    expect(result.data.mode).toBe("unavailable");
    expect(result.data.results).toEqual([]);
    expect(result.data.snapshot_coverage).toBeDefined();
    expect(result.data.snapshot_coverage?.sources).toHaveLength(3);
    expect(result.warnings.some((warning) => warning.includes("Trending bootstrap in progress"))).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.includes("trove sync") || warning.includes("later day"),
      ),
    ).toBe(true);
    expect(result.meta).toEqual(testMeta);
  });

  it("blocks similarity output without semantic scholar api key", async () => {
    const { service, semantic } = createService();
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: canonicalPaper },
    });

    const result = await service.findSimilarPapers("arxiv:1706.03762", 5);
    expect(result.status).toBe("error");
    expect(result.data.papers).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes("SEMANTIC_SCHOLAR_API_KEY"))).toBe(true);
    expect(semantic.findSimilarPapers).not.toHaveBeenCalled();
  });

  it("fails closed when references are expected but unavailable", async () => {
    const { service, openAlex, semantic } = createService();
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: canonicalPaper },
    });
    openAlex.getReferences.mockResolvedValue([]);
    semantic.getReferences.mockResolvedValue([]);

    const result = await service.getReferences("doi:10.1/base", 5);
    expect(result.status).toBe("error");
    expect(result.data.references).toHaveLength(0);
  });

  it("fails closed when literature map evidence quality is insufficient", async () => {
    const { service } = createService();
    vi.spyOn(service, "searchPapers").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: {
        results: [
          {
            paper: {
              ...canonicalPaper,
              id: "arxiv:1706.03762",
              abstract: "",
            },
            score: 1,
            reasons: [],
          },
        ],
      },
    });
    vi.spyOn(service, "getFullText").mockResolvedValue({
      status: "partial",
      degraded: true,
      warnings: ["No full-text PDF source could be resolved."],
      provenance: [],
      meta: testMeta,
      data: {
        fullText: {
          paperId: "arxiv:1706.03762",
          source: "none",
          availability: "unavailable",
          truncation: { truncated: false, maxChunks: 20, returnedChunks: 0 },
          chunks: [],
        },
      },
    });

    const result = await service.buildLiteratureMap("transformer", 1);
    expect(result.status).toBe("error");
    expect(result.data.map.keyClaims).toEqual([]);
  });

  it("fails closed on asymmetric compare evidence", async () => {
    const { service } = createService();
    const paperA = { ...canonicalPaper, id: "doi:10.1/a", doi: "10.1/a" };
    const paperB = { ...canonicalPaper, id: "doi:10.1/b", doi: "10.1/b", abstract: "short" };
    const lookup = new Map<string, CanonicalPaper>([
      [paperA.id, paperA],
      [paperB.id, paperB],
    ]);

    vi.spyOn(service, "getPaper").mockImplementation(async (identifier: string) => {
      const found = lookup.get(identifier);
      const response: Envelope<{ paper: CanonicalPaper | null }> = {
        status: found ? "ok" : "error",
        degraded: !found,
        warnings: found ? [] : ["Paper not found"],
        provenance: [],
        meta: testMeta,
        data: { paper: found ?? null },
      };
      return response;
    });
    vi.spyOn(service, "getFullText").mockImplementation(async (identifier: string) => {
      const fullTextAvailable = identifier === paperA.id;
      return {
        status: fullTextAvailable ? "ok" : "partial",
        degraded: !fullTextAvailable,
        warnings: fullTextAvailable ? [] : ["fallback"],
        provenance: [],
        meta: testMeta,
        data: {
          fullText: fullTextAvailable
            ? {
                paperId: identifier,
                source: "arxiv" as const,
                sourceUrl: "https://arxiv.org/pdf/x.pdf",
                availability: "full_text" as const,
                truncation: { truncated: false, maxChunks: 20, returnedChunks: 2 },
                chunks: [
                  { index: 0, text: "We propose a method. Results improve accuracy across datasets.", tokenEstimate: 18 },
                  { index: 1, text: "However, the method has compute limitations and requires larger models.", tokenEstimate: 18 },
                ],
              }
            : {
                paperId: identifier,
                source: "none" as const,
                availability: "unavailable" as const,
                truncation: { truncated: false, maxChunks: 20, returnedChunks: 0 },
                chunks: [],
              },
        },
      };
    });

    const result = await service.comparePapers([paperA.id, paperB.id]);
    expect(result.status).toBe("error");
    expect(result.data.comparison.papers).toEqual([]);
  });

  it("supports disabling failing tools from registration", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    };
    const fakeContext = {
      service: {
        searchPapers: vi.fn(),
        getTrendingPapers: vi.fn(),
        getPaper: vi.fn(),
        getFullText: vi.fn(),
        getCitations: vi.fn(),
        getReferences: vi.fn(),
        findSimilarPapers: vi.fn(),
        getAuthor: vi.fn(),
        getInstitutionOutput: vi.fn(),
        getCoauthorNetwork: vi.fn(),
        buildLiteratureMap: vi.fn(),
        comparePapers: vi.fn(),
        traceIdea: vi.fn(),
      },
    };

    registerTools(fakeServer as never, fakeContext as never, ["find_similar_papers", "get_trending_papers"]);
    expect(registered).not.toContain("find_similar_papers");
    expect(registered).not.toContain("get_trending_papers");
    expect(registered).toContain("search_papers");
  });

  it("does not emit paperswithcode provenance in strict flows", async () => {
    const { service } = createService();
    const result = await service.getTrendingPapers("transformer", 30);
    expect(result.provenance.every((entry) => entry.source !== "paperswithcode")).toBe(true);
  });

  it("does not cache incomplete author enrichment as authoritative", async () => {
    const { service, openAlex, repo } = createService();
    openAlex.getAuthor.mockResolvedValue({
      id: "A1",
      name: "Yoshua Bengio",
      aliases: [],
      affiliation: "Mila",
      hIndex: 183,
      citationCount: 443796,
      paperCount: 1281,
      mostCitedPaperIds: [],
      recentPaperIds: [],
    });

    const result = await service.getAuthor("Yoshua Bengio");
    expect(result.status).toBe("partial");
    expect(
      result.warnings.some((warning) => warning.includes("best-effort enrichment")),
    ).toBe(true);
    expect(repo.upsertAuthor).not.toHaveBeenCalled();
  });

  it("registers version resource and exposes envelope version metadata", async () => {
    const resources: Array<{ name: string; uri: string; handler: () => Promise<{ contents: Array<{ text: string }> }> }> = [];
    const fakeServer = {
      registerResource: (
        name: string,
        uri: string,
        _meta: unknown,
        handler: () => Promise<{ contents: Array<{ text: string }> }>,
      ) => {
        resources.push({ name, uri, handler });
      },
    };
    const { service } = createService();
    registerResources(fakeServer as never, { service } as never);

    const versionResource = resources.find((resource) => resource.uri === "trove://resources/version");
    expect(versionResource).toBeDefined();
    const payload = versionResource ? await versionResource.handler() : null;
    expect(payload?.contents[0]?.text).toContain("\"version\": \"0.1.9\"");
  });
});
