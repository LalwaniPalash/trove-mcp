import type { AppConfig } from "../core/config.js";
import type { CanonicalPaper, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

interface HuggingFacePaperAuthor {
  name?: string;
}

interface HuggingFacePaperRecord {
  id?: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
  authors?: HuggingFacePaperAuthor[];
  githubRepo?: string;
  upvotes?: number;
}

interface HuggingFacePaperItem {
  paper?: HuggingFacePaperRecord;
  title?: string;
  summary?: string;
  publishedAt?: string;
}

function normalizeArxivId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/^arxiv:/, "");
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function toCanonicalPaper(item: HuggingFacePaperItem): CanonicalPaper | null {
  const record = item.paper ?? {};
  const title = String(item.title ?? record.title ?? "").trim();
  if (!title) {
    return null;
  }

  const arxivId = normalizeArxivId(record.id);
  const doi = arxivId ? `10.48550/arXiv.${arxivId}` : undefined;
  const publishedAt = String(item.publishedAt ?? record.publishedAt ?? "");
  const year = /^\d{4}/.test(publishedAt) ? Number(publishedAt.slice(0, 4)) : undefined;
  const authors = (Array.isArray(record.authors) ? record.authors : [])
    .map((author) => ({ name: String(author.name ?? "").trim() }))
    .filter((author) => author.name.length > 0);

  const id = doi
    ? `doi:${doi.toLowerCase()}`
    : arxivId
      ? `arxiv:${arxivId}`
      : `hf:${title.toLowerCase().replace(/\s+/g, "-").slice(0, 80)}`;

  const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined;
  const url = arxivId ? `https://arxiv.org/abs/${arxivId}` : pdfUrl ?? "";

  return {
    id,
    title,
    abstract: String(item.summary ?? record.summary ?? "").trim(),
    year,
    venue: "Hugging Face Papers",
    doi,
    arxivId,
    pubmedId: undefined,
    s2Id: undefined,
    openAlexId: undefined,
    url,
    pdfUrl,
    citationCount: undefined,
    referenceCount: undefined,
    authors,
    institutions: [],
    topics: [],
    fields: ["computer science"],
    openAccess: Boolean(pdfUrl),
    sourcePriority: ["huggingface"],
  };
}

export class HuggingFaceAdapter {
  private readonly provider: ProviderName = "huggingface";
  private readonly baseUrl: string;

  constructor(
    private readonly httpClient: HttpClient,
    config: AppConfig,
  ) {
    this.baseUrl = config.huggingFaceBaseUrl ?? "https://huggingface.co";
  }

  async getDailyPapers(limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/api/daily_papers`);
    url.searchParams.set("sort", "trending");
    url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 100))));

    const response = await this.httpClient.requestJson<unknown[]>(
      this.provider,
      url.toString(),
      {
        endpointLabel: "huggingface:daily_papers",
        license: "HF Terms",
      },
    );

    const list = Array.isArray(response.data) ? response.data : [];
    return list
      .map((item) => toCanonicalPaper(item as HuggingFacePaperItem))
      .filter((paper): paper is CanonicalPaper => Boolean(paper));
  }

  async searchPapers(query: string, limit: number): Promise<CanonicalPaper[]> {
    const url = new URL(`${this.baseUrl}/api/papers/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 100))));

    const response = await this.httpClient.requestJson<unknown[]>(
      this.provider,
      url.toString(),
      {
        endpointLabel: "huggingface:papers/search",
        license: "HF Terms",
      },
    );

    const list = Array.isArray(response.data) ? response.data : [];
    return list
      .map((item) => toCanonicalPaper(item as HuggingFacePaperItem))
      .filter((paper): paper is CanonicalPaper => Boolean(paper));
  }
}
