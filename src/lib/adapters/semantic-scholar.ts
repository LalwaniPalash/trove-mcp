import type { AppConfig } from "../core/config.js";
import type { CanonicalAuthor, CanonicalPaper, ProviderName, SearchFilters } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

const SEARCH_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "citationCount",
  "referenceCount",
  "externalIds",
  "authors",
  "fieldsOfStudy",
  "venue",
  "url",
  "openAccessPdf",
].join(",");

function toCanonicalPaper(paper: Record<string, unknown>): CanonicalPaper {
  const externalIds = (paper.externalIds as Record<string, unknown> | undefined) ?? {};
  const authors = (Array.isArray(paper.authors) ? paper.authors : [])
    .map((author) => {
      const typed = author as Record<string, unknown>;
      return {
        id: typed.authorId ? String(typed.authorId) : undefined,
        name: String(typed.name ?? "Unknown"),
      };
    })
    .filter((author) => author.name !== "Unknown");

  const fields = (Array.isArray(paper.fieldsOfStudy) ? paper.fieldsOfStudy : [])
    .map((field) => String(field))
    .filter(Boolean);

  const doi = externalIds.DOI ? String(externalIds.DOI) : undefined;
  const arxivId = externalIds.ArXiv ? String(externalIds.ArXiv) : undefined;
  const pubmedId = externalIds.PubMed ? String(externalIds.PubMed) : undefined;
  const s2Id = paper.paperId ? String(paper.paperId) : undefined;

  const id = doi
    ? `doi:${doi.toLowerCase()}`
    : arxivId
      ? `arxiv:${arxivId.toLowerCase()}`
      : s2Id
        ? `s2:${s2Id}`
        : `title:${String(paper.title ?? "unknown").toLowerCase()}:${String(paper.year ?? "unknown")}`;

  return {
    id,
    title: String(paper.title ?? "Untitled"),
    abstract: String(paper.abstract ?? ""),
    year: Number(paper.year ?? 0) || undefined,
    venue: String(paper.venue ?? ""),
    doi,
    arxivId,
    pubmedId,
    s2Id,
    openAlexId: undefined,
    url: String(paper.url ?? ""),
    pdfUrl: typeof (paper.openAccessPdf as Record<string, unknown> | undefined)?.url === "string"
      ? String((paper.openAccessPdf as Record<string, unknown>).url)
      : undefined,
    citationCount: Number(paper.citationCount ?? 0),
    referenceCount: Number(paper.referenceCount ?? 0),
    authors,
    institutions: [],
    topics: fields,
    fields,
    openAccess: Boolean((paper.openAccessPdf as Record<string, unknown> | undefined)?.url),
    sourcePriority: ["semantic_scholar"],
  };
}

export class SemanticScholarAdapter {
  private readonly provider: ProviderName = "semantic_scholar";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly hasKey: boolean;

  constructor(
    private readonly httpClient: HttpClient,
    config: AppConfig,
  ) {
    this.baseUrl = config.semanticScholarBaseUrl ?? "https://api.semanticscholar.org";
    this.hasKey = Boolean(config.semanticScholarApiKey);
    this.headers = config.semanticScholarApiKey
      ? { "x-api-key": config.semanticScholarApiKey }
      : {};
  }

  hasApiKeyConfigured(): boolean {
    return this.hasKey;
  }

  reliableRecommendationsWarning(): string {
    return this.hasKey
      ? ""
      : "Semantic similarity requires SEMANTIC_SCHOLAR_API_KEY for reliable Semantic Scholar recommendations.";
  }

  private keyWarning(): string | null {
    return this.hasKey
      ? null
      : "Semantic Scholar is accessible without a key, but unauthenticated requests use a shared pool and may be throttled (429).";
  }

  private buildQuery(filters: SearchFilters): string {
    const terms: string[] = [];
    if (filters.field) {
      terms.push(`field:${filters.field}`);
    }
    if (filters.topic) {
      terms.push(`topic:${filters.topic}`);
    }
    return terms.join(" ");
  }

  async searchPapers(query: string, filters: SearchFilters = {}): Promise<{ papers: CanonicalPaper[]; warnings: string[] }> {
    const finalQuery = [query, this.buildQuery(filters)].filter(Boolean).join(" ");
    const url = new URL(`${this.baseUrl}/graph/v1/paper/search`);
    url.searchParams.set("query", finalQuery);
    url.searchParams.set("limit", String(filters.limit ?? 25));
    url.searchParams.set("fields", SEARCH_FIELDS);

    const warnings: string[] = [];
    const keyWarning = this.keyWarning();
    if (keyWarning) {
      warnings.push(keyWarning);
    }

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:paper/search",
      license: "S2 Terms",
    });

    const data = Array.isArray(response.data.data) ? response.data.data : [];
    const papers = data.map((item) => toCanonicalPaper(item as Record<string, unknown>));
    return { papers, warnings };
  }

  async getPaper(identifier: string): Promise<CanonicalPaper | null> {
    const url = new URL(`${this.baseUrl}/graph/v1/paper/${encodeURIComponent(identifier)}`);
    url.searchParams.set("fields", SEARCH_FIELDS);

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:paper/get",
      license: "S2 Terms",
    });
    return toCanonicalPaper(response.data);
  }

  async getCitations(identifier: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/graph/v1/paper/${encodeURIComponent(identifier)}/citations`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", SEARCH_FIELDS);

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:paper/citations",
      license: "S2 Terms",
    });

    const data = Array.isArray(response.data.data) ? response.data.data : [];
    return data
      .map((item) => (item as Record<string, unknown>).citingPaper)
      .filter((paper): paper is Record<string, unknown> => Boolean(paper))
      .map((paper) => toCanonicalPaper(paper));
  }

  async getReferences(identifier: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/graph/v1/paper/${encodeURIComponent(identifier)}/references`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", SEARCH_FIELDS);

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:paper/references",
      license: "S2 Terms",
    });

    const data = Array.isArray(response.data.data) ? response.data.data : [];
    return data
      .map((item) => (item as Record<string, unknown>).citedPaper)
      .filter((paper): paper is Record<string, unknown> => Boolean(paper))
      .map((paper) => toCanonicalPaper(paper));
  }

  async findSimilarPapers(identifier: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/recommendations/v1/papers/forpaper/${encodeURIComponent(identifier)}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", SEARCH_FIELDS);

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:paper/recommendations",
      license: "S2 Terms",
    });

    const data = Array.isArray(response.data.recommendedPapers)
      ? response.data.recommendedPapers
      : [];

    return data.map((paper) => toCanonicalPaper(paper as Record<string, unknown>));
  }

  async getAuthor(identifier: string): Promise<CanonicalAuthor | null> {
    const url = new URL(`${this.baseUrl}/graph/v1/author/${encodeURIComponent(identifier)}`);
    url.searchParams.set(
      "fields",
      "authorId,name,affiliations,hIndex,paperCount,citationCount,papers.paperId,papers.citationCount,papers.year",
    );

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "semantic-scholar:author/get",
      license: "S2 Terms",
    });

    const papers = Array.isArray(response.data.papers)
      ? (response.data.papers as Array<Record<string, unknown>>)
      : [];

    const byCitation = [...papers].sort(
      (a, b) => Number(b.citationCount ?? 0) - Number(a.citationCount ?? 0),
    );

    const byRecent = [...papers].sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0));

    return {
      id: String(response.data.authorId ?? identifier),
      name: String(response.data.name ?? "Unknown"),
      aliases: [],
      affiliation: String((Array.isArray(response.data.affiliations) ? response.data.affiliations[0] : "") ?? ""),
      hIndex: Number(response.data.hIndex ?? 0),
      citationCount: Number(response.data.citationCount ?? 0),
      paperCount: Number(response.data.paperCount ?? papers.length),
      mostCitedPaperIds: byCitation
        .slice(0, 10)
        .map((paper) => String(paper.paperId ?? ""))
        .filter(Boolean),
      recentPaperIds: byRecent
        .slice(0, 10)
        .map((paper) => String(paper.paperId ?? ""))
        .filter(Boolean),
    };
  }
}
