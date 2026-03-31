import type { CanonicalPaper, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";
import type { AppConfig } from "../core/config.js";

export class PubMedAdapter {
  private readonly provider: ProviderName = "pubmed";
  private readonly baseUrl: string;

  constructor(
    private readonly httpClient: HttpClient,
    config?: AppConfig,
  ) {
    this.baseUrl = config?.pubmedBaseUrl ?? "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  }

  async searchPapers(query: string, limit: number): Promise<CanonicalPaper[]> {
    const esearch = new URL(`${this.baseUrl}/esearch.fcgi`);
    esearch.searchParams.set("db", "pubmed");
    esearch.searchParams.set("retmode", "json");
    esearch.searchParams.set("retmax", String(limit));
    esearch.searchParams.set("term", query);

    const searchResponse = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      esearch.toString(),
      {
        endpointLabel: "pubmed:esearch",
        license: "NCBI Terms",
      },
    );

    const idList = Array.isArray((searchResponse.data.esearchresult as Record<string, unknown> | undefined)?.idlist)
      ? ((searchResponse.data.esearchresult as Record<string, unknown>).idlist as string[])
      : [];

    if (idList.length === 0) {
      return [];
    }

    return this.getSummaryByIds(idList);
  }

  async getPaperByPmid(pmid: string): Promise<CanonicalPaper | null> {
    const papers = await this.getSummaryByIds([pmid.replace(/^pmid:/i, "")]);
    return papers[0] ?? null;
  }

  private async getSummaryByIds(ids: string[]): Promise<CanonicalPaper[]> {
    const esummary = new URL(`${this.baseUrl}/esummary.fcgi`);
    esummary.searchParams.set("db", "pubmed");
    esummary.searchParams.set("retmode", "json");
    esummary.searchParams.set("id", ids.join(","));

    const response = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      esummary.toString(),
      {
        endpointLabel: "pubmed:esummary",
        license: "NCBI Terms",
      },
    );

    const result = (response.data.result as Record<string, unknown> | undefined) ?? {};
    const uids = Array.isArray(result.uids) ? result.uids : [];

    return uids.map((uid) => {
      const item = (result[String(uid)] as Record<string, unknown> | undefined) ?? {};
      const authors = Array.isArray(item.authors)
        ? (item.authors as Array<Record<string, unknown>>).map((author) => ({
            name: String(author.name ?? "Unknown"),
          }))
        : [];

      const title = String(item.title ?? "Untitled");
      const year = Number(String(item.pubdate ?? "").slice(0, 4)) || undefined;

      const articleIds = Array.isArray(item.articleids)
        ? (item.articleids as Array<Record<string, unknown>>)
        : [];
      const doi = articleIds.find((articleId) => String(articleId.idtype) === "doi")?.value;

      return {
        id: `pmid:${uid}`,
        title,
        abstract: undefined,
        year,
        venue: String(item.fulljournalname ?? ""),
        doi: doi ? String(doi) : undefined,
        arxivId: undefined,
        pubmedId: String(uid),
        s2Id: undefined,
        openAlexId: undefined,
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
        pdfUrl: undefined,
        citationCount: undefined,
        referenceCount: undefined,
        authors,
        institutions: [],
        topics: [],
        fields: ["biomedicine"],
        openAccess: false,
        sourcePriority: ["pubmed"],
      } satisfies CanonicalPaper;
    });
  }
}
