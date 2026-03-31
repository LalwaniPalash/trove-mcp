import { describe, expect, it, vi } from "vitest";
import { setDefaultEnvelopeMeta } from "../../src/lib/core/envelope.js";
import { ResearchService } from "../../src/lib/core/research-service.js";
import type { CanonicalPaper, SearchResult } from "../../src/lib/types/common.js";

const testMeta = { version: "0.1.9" };

const basePaper: CanonicalPaper = {
  id: "doi:10.1/base",
  title: "Transformer methods for language understanding",
  abstract: "We show transformer attention improves language modeling.",
  year: 2023,
  venue: "ACL",
  doi: "10.1/base",
  arxivId: undefined,
  pubmedId: undefined,
  s2Id: undefined,
  openAlexId: "W123",
  url: "https://openalex.org/W123",
  pdfUrl: undefined,
  citationCount: 50,
  referenceCount: 20,
  authors: [{ name: "A" }],
  institutions: ["Inst A"],
  topics: ["transformer"],
  fields: ["computer science"],
  openAccess: true,
  sourcePriority: ["openalex"],
};

function createRepoMock() {
  return {
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
}

function createService() {
  setDefaultEnvelopeMeta(testMeta);
  const repo = createRepoMock();
  const logger = { warn: vi.fn() };
  const openAlex = {
    searchPapers: vi.fn(async () => ({ papers: [basePaper], warnings: [] })),
    getPaperByIdentifier: vi.fn(async () => basePaper),
    getReferences: vi.fn(async () => []),
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
  const emptySearch = vi.fn(async () => []);
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
    { searchPapers: emptySearch } as never,
    { isConfigured: vi.fn(() => false), getByDoi: vi.fn(async () => null) } as never,
    { searchPapers: emptySearch } as never,
    { searchPapers: emptySearch, findPdfByDoi: vi.fn(async () => null) } as never,
    huggingFace as never,
  );

  return { service, repo, openAlex, semantic, huggingFace };
}

describe("ResearchService lockdown behavior", () => {
  it("returns trending unavailable when snapshot velocity evidence is absent", async () => {
    const { service } = createService();
    const envelope = await service.getTrendingPapers("transformer attention mechanism", 30);

    expect(envelope.data.mode).toBe("unavailable");
    expect(envelope.data.results).toHaveLength(0);
    expect(envelope.data.snapshot_coverage?.candidate_count).toBeGreaterThanOrEqual(0);
    expect(envelope.data.snapshot_coverage?.bootstrap_started).toBe(true);
    expect(envelope.data.snapshot_coverage?.sources).toHaveLength(3);
    expect(envelope.meta).toEqual(testMeta);
    expect(envelope.status).toBe("partial");
    expect(envelope.warnings.some((w) => w.includes("Trending bootstrap in progress"))).toBe(true);
    expect(envelope.warnings.some((w) => w.includes("Trending unavailable"))).toBe(true);
  });

  it("returns snapshot mode when citation velocity is non-zero", async () => {
    const { service, repo } = createService();
    repo.getCitationVelocity.mockReturnValue(3);
    repo.getCitationSnapshotCount.mockReturnValue(2);
    const envelope = await service.getTrendingPapers("transformer attention mechanism", 30);

    expect(envelope.data.mode).toBe("snapshot");
    expect(envelope.data.results.length).toBeGreaterThan(0);
    expect(envelope.data.snapshot_coverage?.non_zero_velocity_count).toBeGreaterThan(0);
    expect(envelope.data.results[0].reasons.some((r) => r.startsWith("velocity:"))).toBe(true);
  });

  it("chooses canonical title candidate instead of first search row", async () => {
    const { service, repo } = createService();

    const weak: CanonicalPaper = {
      ...basePaper,
      id: "doi:10.65215/2q58a426",
      doi: "10.65215/2q58a426",
      title: "Attention Is All You Need",
      citationCount: 4,
      year: 2025,
      openAlexId: "W999",
    };
    const strong: CanonicalPaper = {
      ...basePaper,
      id: "doi:10.48550/arxiv.1706.03762",
      doi: "10.48550/arxiv.1706.03762",
      title: "Attention Is All You Need",
      citationCount: 140000,
      year: 2017,
      openAlexId: "W1514731200",
    };

    const searchResults: SearchResult[] = [
      { paper: weak, score: 95, reasons: [] },
      { paper: strong, score: 92, reasons: [] },
    ];

    vi.spyOn(service, "searchPapers").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { results: searchResults },
    });

    const envelope = await service.getPaper("Attention Is All You Need");
    expect(repo.getPaperByIdentifier).toHaveBeenCalledWith("Attention Is All You Need");
    expect(envelope.data.paper?.id).toBe("doi:10.48550/arxiv.1706.03762");
    expect(envelope.data.paper?.year).toBe(2017);
  });

  it("returns deterministic error when semantic scholar api key is missing for similarity", async () => {
    const { service, semantic } = createService();
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: basePaper },
    });

    const envelope = await service.findSimilarPapers(basePaper.id, 5);
    expect(envelope.status).toBe("error");
    expect(envelope.data.papers).toHaveLength(0);
    expect(envelope.warnings.some((w) => w.includes("SEMANTIC_SCHOLAR_API_KEY"))).toBe(true);
    expect(semantic.findSimilarPapers).not.toHaveBeenCalled();
  });

  it("returns explicit error when references are expected but unavailable", async () => {
    const { service, openAlex, semantic } = createService();
    const paperWithRefs: CanonicalPaper = { ...basePaper, referenceCount: 25 };
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: paperWithRefs },
    });
    openAlex.getReferences.mockResolvedValue([]);
    semantic.getReferences.mockResolvedValue([]);

    const envelope = await service.getReferences(basePaper.id, 5);
    expect(envelope.status).toBe("error");
    expect(envelope.degraded).toBe(true);
    expect(envelope.data.references).toHaveLength(0);
    expect(
      envelope.warnings.some((w) => w.includes("metadata indicates references exist")),
    ).toBe(true);
  });

  it("adds explicit coverage-gap guidance when S2 404s and OpenAlex exposes no references", async () => {
    const { service, openAlex, semantic } = createService();
    const arxivOnlyPaper: CanonicalPaper = {
      ...basePaper,
      id: "arxiv:2312.11805",
      doi: "10.48550/arXiv.2312.11805",
      arxivId: "2312.11805",
      s2Id: undefined,
      referenceCount: 200,
    };
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: arxivOnlyPaper },
    });
    semantic.getReferences.mockRejectedValue(new Error("Upstream semantic_scholar error (404)"));
    openAlex.getReferences.mockResolvedValue([]);

    const envelope = await service.getReferences(arxivOnlyPaper.id, 5);
    expect(envelope.status).toBe("error");
    expect(
      envelope.warnings.some((warning) => warning.includes("Coverage gap: Semantic Scholar does not index this paper")),
    ).toBe(true);
    expect(
      envelope.warnings.some((warning) => warning.includes("Try get_full_text to inspect inline citations directly")),
    ).toBe(true);
  });

  it("tries ARXIV handle for semantic references when s2 and DOI fail", async () => {
    const { service, semantic } = createService();
    const arxivPaper: CanonicalPaper = {
      ...basePaper,
      doi: undefined,
      s2Id: undefined,
      arxivId: "2312.11805",
      referenceCount: 3,
    };
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: arxivPaper },
    });
    semantic.getReferences.mockImplementation(async (handle: string) => {
      if (handle === "ARXIV:2312.11805") {
        return [{ ...basePaper, id: "doi:10.1/ref-1", referenceCount: 0 }];
      }
      return [];
    });

    const envelope = await service.getReferences(arxivPaper.id, 5);
    expect(envelope.status).not.toBe("error");
    expect(envelope.data.references.length).toBeGreaterThan(0);
  });

  it("refreshes stale cached full-text payloads automatically", async () => {
    const { service, repo } = createService();
    vi.spyOn(service, "getPaper").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: { paper: { ...basePaper, id: "arxiv:2302.07842", arxivId: "2302.07842" } },
    });
    repo.getFullText.mockReturnValue({
      paperId: "arxiv:2302.07842",
      source: "arxiv",
      availability: "full_text",
      truncation: { truncated: true, maxChunks: 20, returnedChunks: 20 },
      chunks: Array.from({ length: 20 }, (_, index) => ({
        index,
        text: index % 2 === 0 ? "a@b.com" : "1",
        tokenEstimate: 1,
      })),
    });

    const envelope = await service.getFullText("arxiv:2302.07842");
    expect(repo.deleteFullText).toHaveBeenCalledWith("arxiv:2302.07842");
    expect(
      envelope.warnings.some((warning) => warning.includes("Cached full text failed quality checks")),
    ).toBe(true);
  });

  it("fails closed for coauthor network when author ID is not OpenAlex ID", async () => {
    const { service } = createService();
    vi.spyOn(service, "getAuthor").mockResolvedValue({
      status: "ok",
      degraded: false,
      warnings: [],
      provenance: [],
      meta: testMeta,
      data: {
        author: {
          id: "12345",
          name: "Ilya Sutskever",
          aliases: [],
          affiliation: "X",
          hIndex: 1,
          citationCount: 1,
          paperCount: 1,
          mostCitedPaperIds: [],
          recentPaperIds: [],
        },
      },
    });

    const envelope = await service.getCoauthorNetwork("Ilya Sutskever");
    expect(envelope.status).toBe("error");
    expect(envelope.data.edges).toEqual([]);
  });

  it("returns author as partial and does not cache incomplete openalex enrichment", async () => {
    const { service, openAlex, repo } = createService();
    openAlex.getAuthor.mockResolvedValue({
      id: "A1",
      name: "Yoshua Bengio",
      aliases: [],
      affiliation: "Mila",
      hIndex: 100,
      citationCount: 10,
      paperCount: 100,
      mostCitedPaperIds: [],
      recentPaperIds: [],
    });

    const envelope = await service.getAuthor("Yoshua Bengio");
    expect(envelope.status).toBe("partial");
    expect(
      envelope.warnings.some((warning) => warning.includes("best-effort enrichment")),
    ).toBe(true);
    expect(repo.upsertAuthor).not.toHaveBeenCalled();
  });

  it("does not trust cached author entries with incomplete enrichment", async () => {
    const { service, repo, openAlex } = createService();
    repo.getAuthor.mockReturnValue({
      id: "A1",
      name: "Yoshua Bengio",
      aliases: [],
      affiliation: "Mila",
      hIndex: 100,
      citationCount: 10,
      paperCount: 100,
      mostCitedPaperIds: [],
      recentPaperIds: [],
    });
    openAlex.getAuthor.mockResolvedValue({
      id: "A1",
      name: "Yoshua Bengio",
      aliases: [],
      affiliation: "Mila",
      hIndex: 100,
      citationCount: 10,
      paperCount: 100,
      mostCitedPaperIds: ["W1"],
      recentPaperIds: ["W2"],
    });

    const envelope = await service.getAuthor("Yoshua Bengio");
    expect(envelope.status).toBe("ok");
    expect(envelope.data.author?.mostCitedPaperIds).toEqual(["W1"]);
    expect(openAlex.getAuthor).toHaveBeenCalled();
  });
});
