import type { CanonicalPaper, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";
import type { AppConfig } from "../core/config.js";
import { toErrorMessage } from "../core/errors.js";

interface PaperWithCodePaper {
  id: string;
  title: string;
  abstract?: string;
  published?: string;
  url_abs?: string;
  url_pdf?: string;
}

export class PapersWithCodeAdapter {
  private readonly provider: ProviderName = "paperswithcode";
  private readonly baseUrl: string;

  constructor(
    private readonly httpClient: HttpClient,
    config?: AppConfig,
  ) {
    this.baseUrl = config?.papersWithCodeBaseUrl ?? "https://paperswithcode.com/api/v1";
  }

  async searchPapers(
    query: string,
    limit: number,
  ): Promise<{ papers: CanonicalPaper[]; warnings: string[] }> {
    const url = new URL(`${this.baseUrl}/papers`);
    url.searchParams.set("q", query);
    url.searchParams.set("page_size", String(limit));

    let response: { data: Record<string, unknown> };
    try {
      response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        url.toString(),
        {
          endpointLabel: "paperswithcode:papers/search",
          license: "PapersWithCode Terms",
        },
      );
    } catch (error) {
      const message = toErrorMessage(error);
      const endpointRedirected =
        message.includes("huggingface.co/papers/trending") ||
        message.includes("UPSTREAM_REDIRECT") ||
        message.includes("redirected");

      if (endpointRedirected) {
        return {
          papers: [],
          warnings: [
            "PapersWithCode public endpoint appears redirected/deprecated; skipping PapersWithCode search source.",
          ],
        };
      }

      throw error;
    }

    const results = Array.isArray(response.data.results)
      ? (response.data.results as PaperWithCodePaper[])
      : [];

    const papers = results.map((paper) => {
      const year = paper.published ? Number(paper.published.slice(0, 4)) : undefined;
      return {
        id: `pwc:${paper.id}`,
        title: paper.title ?? "Untitled",
        abstract: paper.abstract,
        year,
        venue: "PapersWithCode",
        doi: undefined,
        arxivId: undefined,
        pubmedId: undefined,
        s2Id: undefined,
        openAlexId: undefined,
        url: paper.url_abs ?? "",
        pdfUrl: paper.url_pdf,
        citationCount: undefined,
        referenceCount: undefined,
        authors: [],
        institutions: [],
        topics: ["machine learning"],
        fields: ["computer science"],
        openAccess: Boolean(paper.url_pdf),
        sourcePriority: ["paperswithcode"],
      } satisfies CanonicalPaper;
    });

    return { papers, warnings: [] };
  }

  async getCodeReposByPaperId(paperId: string): Promise<string[]> {
    const id = paperId.replace(/^pwc:/, "");
    const url = new URL(`${this.baseUrl}/papers/${id}/repositories`);

    const response = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      url.toString(),
      {
        endpointLabel: "paperswithcode:paper/repositories",
        license: "PapersWithCode Terms",
      },
    );
    const results = Array.isArray(response.data.results)
      ? (response.data.results as Array<Record<string, unknown>>)
      : [];
    return results
      .map((item) => String(item.url ?? ""))
      .filter((urlValue) => urlValue.startsWith("http"));
  }
}
