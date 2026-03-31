import type { AppConfig } from "../core/config.js";
import type { CanonicalPaper, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

export class CoreAdapter {
  private readonly provider: ProviderName = "core";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly httpClient: HttpClient,
    config: AppConfig,
  ) {
    this.baseUrl = config.coreBaseUrl ?? "https://api.core.ac.uk/v3";
    this.headers = config.coreApiKey
      ? { Authorization: `Bearer ${config.coreApiKey}` }
      : {};
  }

  async searchPapers(query: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/search/works/`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));

    const response = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      url.toString(),
      {
        headers: this.headers,
        endpointLabel: "core:search/works",
        license: "CORE Terms",
      },
    );

    const results = Array.isArray(response.data.results)
      ? (response.data.results as Array<Record<string, unknown>>)
      : [];

    return results.map((work) => {
      const year = Number(work.yearPublished ?? 0) || undefined;
      const authors = Array.isArray(work.authors)
        ? (work.authors as string[]).map((name) => ({ name }))
        : [];
      const doi = typeof work.doi === "string" ? String(work.doi) : undefined;
      const sourceFulltextUrls = Array.isArray(work.sourceFulltextUrls)
        ? (work.sourceFulltextUrls as string[])
        : [];
      return {
        id: doi ? `doi:${doi.toLowerCase()}` : `core:${String(work.id ?? Math.random())}`,
        title: String(work.title ?? "Untitled"),
        abstract: String(work.abstract ?? ""),
        year,
        venue: String(work.publisher ?? ""),
        doi,
        arxivId: undefined,
        pubmedId: undefined,
        s2Id: undefined,
        openAlexId: undefined,
        url: String(work.downloadUrl ?? sourceFulltextUrls[0] ?? ""),
        pdfUrl: String(work.downloadUrl ?? ""),
        citationCount: undefined,
        referenceCount: undefined,
        authors,
        institutions: [],
        topics: [],
        fields: [],
        openAccess: Boolean(work.downloadUrl),
        sourcePriority: ["core"],
      } satisfies CanonicalPaper;
    });
  }

  async findPdfByDoi(doi: string): Promise<string | null> {
    const normalized = doi.replace(/^https?:\/\/doi.org\//i, "").toLowerCase();
    const candidateQueries = [normalized, `doi:${normalized}`];
    let lastError: unknown;

    for (const query of candidateQueries) {
      try {
        const results = await this.searchPapers(query, 5);
        const exact = results.find(
          (paper) => paper.doi?.toLowerCase() === normalized && paper.pdfUrl,
        );
        if (exact?.pdfUrl) {
          return exact.pdfUrl;
        }

        const fallback = results.find((paper) => Boolean(paper.pdfUrl));
        if (fallback?.pdfUrl) {
          return fallback.pdfUrl;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return null;
  }
}
