import type { CanonicalPaper, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";
import type { AppConfig } from "../core/config.js";

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeHtml(match[1].trim()) : undefined;
}

function extractTags(xml: string, tag: string): string[] {
  const matches = [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))];
  return matches.map((match) => decodeHtml(match[1].trim())).filter(Boolean);
}

function parseEntries(feed: string): CanonicalPaper[] {
  const blocks = feed.split("<entry>").slice(1).map((block) => block.split("</entry>")[0]);

  return blocks.map((entry) => {
    const idUrl = extractTag(entry, "id") ?? "";
    const rawId = idUrl.split("/").at(-1)?.replace(/v\d+$/, "") ?? idUrl;
    const title = extractTag(entry, "title") ?? "Untitled";
    const summary = extractTag(entry, "summary") ?? "";
    const published = extractTag(entry, "published") ?? "";
    const year = published ? Number(published.slice(0, 4)) : undefined;

    const authors = extractTags(entry, "name").map((name) => ({ name }));

    return {
      id: `arxiv:${rawId}`,
      title: title.replace(/\s+/g, " ").trim(),
      abstract: summary.replace(/\s+/g, " ").trim(),
      year,
      venue: "arXiv",
      doi: rawId ? `10.48550/arXiv.${rawId}` : undefined,
      arxivId: rawId,
      pubmedId: undefined,
      s2Id: undefined,
      openAlexId: undefined,
      url: idUrl,
      pdfUrl: rawId ? `https://arxiv.org/pdf/${rawId}.pdf` : undefined,
      citationCount: undefined,
      referenceCount: undefined,
      authors,
      institutions: [],
      topics: [],
      fields: [],
      openAccess: true,
      sourcePriority: ["arxiv"],
    };
  });
}

export class ArxivAdapter {
  private readonly provider: ProviderName = "arxiv";
  private readonly baseUrl: string;

  constructor(
    private readonly httpClient: HttpClient,
    config?: AppConfig,
  ) {
    this.baseUrl = config?.arxivBaseUrl ?? "https://export.arxiv.org/api/query";
  }

  async searchPapers(query: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(limit));

    const response = await this.httpClient.requestText(this.provider, url.toString(), {
      endpointLabel: "arxiv:query",
      license: "arXiv Terms",
      headers: {
        Accept: "application/atom+xml",
      },
    });

    return parseEntries(response.data);
  }

  async getPaperByArxivId(id: string): Promise<CanonicalPaper | null> {
    const raw = id.replace(/^arxiv:/i, "");
    const url = new URL(this.baseUrl);
    url.searchParams.set("id_list", raw);

    const response = await this.httpClient.requestText(this.provider, url.toString(), {
      endpointLabel: "arxiv:by-id",
      license: "arXiv Terms",
      headers: {
        Accept: "application/atom+xml",
      },
    });

    return parseEntries(response.data)[0] ?? null;
  }
}
