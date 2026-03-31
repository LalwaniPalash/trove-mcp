import type { AppConfig } from "../core/config.js";
import type { CanonicalAuthor, CanonicalInstitution, CanonicalPaper, ProviderName, SearchFilters } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

function toCanonicalId(id: string): string {
  return id.startsWith("http") ? id.split("/").at(-1) ?? id : id;
}

function sanitizeFilterValue(value: string): string {
  return value.replace(/,/g, " ").trim();
}

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fromInvertedIndex(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) {
    return undefined;
  }

  const words: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      words.push([word, position]);
    }
  }

  if (words.length === 0) {
    return undefined;
  }

  return words
    .sort((a, b) => a[1] - b[1])
    .map(([word]) => word)
    .join(" ");
}

function mapWorkToPaper(work: Record<string, unknown>): CanonicalPaper {
  const id = String(work.id ?? "");
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const concepts = Array.isArray(work.concepts) ? work.concepts : [];
  const primaryLocation = (work.primary_location as Record<string, unknown> | undefined) ?? {};
  const openAccess = (work.open_access as Record<string, unknown> | undefined) ?? {};

  const authors = authorships
    .map((authorship) => {
      const typed = authorship as Record<string, unknown>;
      const author = (typed.author as Record<string, unknown> | undefined) ?? {};
      const institutions = Array.isArray(typed.institutions) ? typed.institutions : [];
      const firstInstitution = institutions[0] as Record<string, unknown> | undefined;
      return {
        id: author.id ? toCanonicalId(String(author.id)) : undefined,
        name: String(author.display_name ?? "Unknown"),
        institution: firstInstitution ? String(firstInstitution.display_name ?? "") : undefined,
      };
    })
    .filter((author) => author.name !== "Unknown");

  const fields = concepts
    .map((concept) => String((concept as Record<string, unknown>).display_name ?? ""))
    .filter(Boolean)
    .slice(0, 10);

  const institutions = authors
    .map((author) => author.institution)
    .filter((institution): institution is string => Boolean(institution));

  const source = (primaryLocation.source as Record<string, unknown> | undefined) ?? {};
  const ids = (work.ids as Record<string, unknown> | undefined) ?? {};
  const doi = typeof work.doi === "string"
    ? String(work.doi).replace(/^https?:\/\/doi.org\//i, "")
    : undefined;
  const arxivFromIds = typeof ids.arxiv === "string"
    ? String(ids.arxiv).replace(/^https?:\/\/arxiv.org\/abs\//i, "").toLowerCase()
    : undefined;
  const arxivFromDoi = doi?.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5}(v\d+)?)$/i)?.[1]?.toLowerCase();
  const arxivId = arxivFromIds ?? arxivFromDoi;

  return {
    id: toCanonicalId(id),
    openAlexId: toCanonicalId(id),
    title: String(work.display_name ?? "Untitled"),
    abstract: fromInvertedIndex((work.abstract_inverted_index as Record<string, number[]> | undefined) ?? undefined),
    year: Number(work.publication_year ?? 0) || undefined,
    venue: String(source.display_name ?? ""),
    doi,
    arxivId,
    citationCount: Number(work.cited_by_count ?? 0),
    referenceCount: Array.isArray(work.referenced_works) ? work.referenced_works.length : undefined,
    url: String(work.id ?? ""),
    pdfUrl: typeof openAccess.oa_url === "string" ? String(openAccess.oa_url) : undefined,
    openAccess: Boolean(openAccess.is_oa),
    authors,
    institutions,
    topics: fields,
    fields,
    sourcePriority: ["openalex"],
  };
}

export class OpenAlexAdapter {
  private readonly provider: ProviderName = "openalex";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly contactEmail?: string;

  constructor(
    private readonly httpClient: HttpClient,
    config: AppConfig,
  ) {
    this.baseUrl = config.openAlexBaseUrl ?? "https://api.openalex.org";
    this.contactEmail = config.contactEmail;
    this.headers = config.contactEmail
      ? { "User-Agent": `trove-mcp/0.1 (mailto:${config.contactEmail})` }
      : { "User-Agent": "trove-mcp/0.1" };
  }

  private applyPoliteQuery(url: URL): void {
    if (this.contactEmail) {
      url.searchParams.set("mailto", this.contactEmail);
    }
  }

  private buildFilterClauses(filters: SearchFilters, includeInstitution = true): string[] {
    const clauses: string[] = [];
    if (filters.year_min) {
      clauses.push(`from_publication_date:${filters.year_min}-01-01`);
    }
    if (filters.year_max) {
      clauses.push(`to_publication_date:${filters.year_max}-12-31`);
    }
    if (filters.open_access_only) {
      clauses.push("is_oa:true");
    }
    if (filters.citation_min) {
      clauses.push(`cited_by_count:>${filters.citation_min}`);
    }
    if (includeInstitution && filters.institution) {
      clauses.push(`raw_affiliation_strings.search:${sanitizeFilterValue(filters.institution)}`);
    }
    if (filters.author) {
      clauses.push(`raw_author_name.search:${sanitizeFilterValue(filters.author)}`);
    }
    return clauses;
  }

  private buildFilter(filters: SearchFilters): string | undefined {
    const clauses = this.buildFilterClauses(filters);
    return clauses.length ? clauses.join(",") : undefined;
  }

  private matchesFilters(paper: CanonicalPaper, filters: SearchFilters): boolean {
    if (filters.year_min && (paper.year ?? 0) < filters.year_min) {
      return false;
    }
    if (filters.year_max && (paper.year ?? Number.MAX_SAFE_INTEGER) > filters.year_max) {
      return false;
    }
    if (filters.open_access_only && !paper.openAccess) {
      return false;
    }
    if (filters.citation_min && (paper.citationCount ?? 0) < filters.citation_min) {
      return false;
    }
    if (filters.field) {
      const needle = normalizeText(filters.field);
      const haystack = normalizeText(`${paper.fields.join(" ")} ${paper.topics.join(" ")}`);
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    if (filters.topic) {
      const needle = normalizeText(filters.topic);
      const haystack = normalizeText(`${paper.title} ${paper.abstract ?? ""} ${paper.topics.join(" ")}`);
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    if (filters.author) {
      const needle = normalizeText(filters.author);
      if (!paper.authors.some((author) => normalizeText(author.name).includes(needle))) {
        return false;
      }
    }
    if (filters.institution) {
      const needle = normalizeText(filters.institution);
      if (!paper.institutions.some((institution) => normalizeText(institution).includes(needle))) {
        return false;
      }
    }
    return true;
  }

  private async fetchAuthorWorkIds(authorId: string, sort: string, limit: number): Promise<string[]> {
    const url = new URL(`${this.baseUrl}/works`);
    this.applyPoliteQuery(url);
    url.searchParams.set("filter", `authorships.author.id:${authorId}`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("per-page", String(limit));

    const response = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      url.toString(),
      {
        headers: this.headers,
        endpointLabel: `openalex:author/works:${sort}`,
        license: "CC0",
      },
    );

    const results = Array.isArray(response.data.results)
      ? (response.data.results as Array<Record<string, unknown>>)
      : [];

    return results
      .map((work) => toCanonicalId(String(work.id ?? "")))
      .filter(Boolean);
  }

  async searchPapers(query: string, filters: SearchFilters = {}): Promise<{ papers: CanonicalPaper[]; warnings: string[] }> {
    const warnings: string[] = [];
    const url = new URL(`${this.baseUrl}/works`);
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(filters.limit ?? 25));
    this.applyPoliteQuery(url);

    const filter = this.buildFilter(filters);
    if (filter) {
      url.searchParams.set("filter", filter);
    }

    let results: unknown[] = [];
    try {
      const response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        url.toString(),
        {
          headers: this.headers,
          endpointLabel: "openalex:works/search",
          license: "CC0",
        },
      );
      results = Array.isArray(response.data.results) ? response.data.results : [];
    } catch (error) {
      if (filter) {
        warnings.push(`OpenAlex filtered search failed; retried without filter: ${String(error)}`);
        url.searchParams.delete("filter");
        const fallbackResponse = await this.httpClient.requestJson<Record<string, unknown>>(
          this.provider,
          url.toString(),
          {
            headers: this.headers,
            endpointLabel: "openalex:works/search:fallback",
            license: "CC0",
          },
        );
        results = Array.isArray(fallbackResponse.data.results)
          ? fallbackResponse.data.results
          : [];
      } else {
        throw error;
      }
    }

    return {
      papers: results.map((work) => mapWorkToPaper(work as Record<string, unknown>)),
      warnings,
    };
  }

  async getPaperByIdentifier(identifier: string): Promise<CanonicalPaper | null> {
    const normalized = identifier.trim();

    if (/^10\.\d{4,9}\//i.test(normalized)) {
      const url = new URL(`${this.baseUrl}/works`);
      this.applyPoliteQuery(url);
      url.searchParams.set("filter", `doi:${normalized.toLowerCase()}`);
      url.searchParams.set("per-page", "1");

      const response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        url.toString(),
        {
          headers: this.headers,
          endpointLabel: "openalex:works/by-doi",
          license: "CC0",
        },
      );

      const result = Array.isArray(response.data.results)
        ? (response.data.results[0] as Record<string, unknown> | undefined)
        : undefined;
      return result ? mapWorkToPaper(result) : null;
    }

    const id = normalized.replace(/^https?:\/\/openalex.org\//i, "");
    if (/^[W]\d+$/i.test(id)) {
      const url = new URL(`${this.baseUrl}/works/${id}`);
      this.applyPoliteQuery(url);
      const response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        url.toString(),
        {
          headers: this.headers,
          endpointLabel: "openalex:works/by-id",
          license: "CC0",
        },
      );
      return mapWorkToPaper(response.data);
    }

    return null;
  }

  async getCitations(openAlexWorkId: string, limit: number): Promise<CanonicalPaper[]> {
    const id = openAlexWorkId.replace(/^https?:\/\/openalex.org\//i, "");
    const url = new URL(`${this.baseUrl}/works`);
    this.applyPoliteQuery(url);
    url.searchParams.set("filter", `cites:${id}`);
    url.searchParams.set("per-page", String(limit));

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "openalex:works/citations",
      license: "CC0",
    });

    const results = Array.isArray(response.data.results) ? response.data.results : [];
    return results.map((work) => mapWorkToPaper(work as Record<string, unknown>));
  }

  async getReferences(openAlexWorkId: string, limit: number): Promise<CanonicalPaper[]> {
    const id = openAlexWorkId.replace(/^https?:\/\/openalex.org\//i, "");
    const workUrl = new URL(`${this.baseUrl}/works/${id}`);
    this.applyPoliteQuery(workUrl);
    const work = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      workUrl.toString(),
      {
        headers: this.headers,
        endpointLabel: "openalex:works/references",
        license: "CC0",
      },
    );

    const refs = Array.isArray(work.data.referenced_works) ? work.data.referenced_works : [];
    const topRefs = refs.slice(0, limit).map((ref) => String(ref).replace(/^https?:\/\/openalex.org\//i, ""));

    const papers: CanonicalPaper[] = [];
    for (const refId of topRefs) {
      try {
        const refUrl = new URL(`${this.baseUrl}/works/${refId}`);
        this.applyPoliteQuery(refUrl);
        const ref = await this.httpClient.requestJson<Record<string, unknown>>(
          this.provider,
          refUrl.toString(),
          {
            headers: this.headers,
            endpointLabel: "openalex:works/reference-item",
            license: "CC0",
          },
        );
        papers.push(mapWorkToPaper(ref.data));
      } catch {
        continue;
      }
    }

    return papers;
  }

  async getAuthorWorksById(authorId: string, limit: number): Promise<CanonicalPaper[]> {
    const normalized = authorId.replace(/^https?:\/\/openalex.org\//i, "");
    const url = new URL(`${this.baseUrl}/works`);
    this.applyPoliteQuery(url);
    url.searchParams.set("filter", `authorships.author.id:https://openalex.org/${normalized}`);
    url.searchParams.set("per-page", String(limit));
    url.searchParams.set("sort", "cited_by_count:desc");

    const response = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      url.toString(),
      {
        headers: this.headers,
        endpointLabel: "openalex:author/works-by-id",
        license: "CC0",
      },
    );

    const results = Array.isArray(response.data.results)
      ? (response.data.results as Array<Record<string, unknown>>)
      : [];
    return results.map((work) => mapWorkToPaper(work));
  }

  async getAuthor(identifier: string): Promise<CanonicalAuthor | null> {
    const id = identifier.replace(/^https?:\/\/openalex.org\//i, "");

    if (/^A\d+$/i.test(id)) {
      const authorUrl = new URL(`${this.baseUrl}/authors/${id}`);
      this.applyPoliteQuery(authorUrl);
      const response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        authorUrl.toString(),
        {
          headers: this.headers,
          endpointLabel: "openalex:author/by-id",
          license: "CC0",
        },
      );

      let mostCitedPaperIds: string[] = [];
      let recentPaperIds: string[] = [];
      try {
        mostCitedPaperIds = await this.fetchAuthorWorkIds(id, "cited_by_count:desc", 10);
      } catch {
        mostCitedPaperIds = [];
      }
      try {
        recentPaperIds = await this.fetchAuthorWorkIds(id, "publication_date:desc", 10);
      } catch {
        recentPaperIds = [];
      }

      return {
        id,
        name: String(response.data.display_name ?? "Unknown"),
        aliases: [],
        affiliation: String(
          ((response.data.last_known_institutions as Array<Record<string, unknown>> | undefined)?.[0]
            ?.display_name as string | undefined) ?? "",
        ),
        hIndex: Number(response.data.summary_stats ? (response.data.summary_stats as Record<string, unknown>).h_index : 0),
        citationCount: Number(response.data.cited_by_count ?? 0),
        paperCount: Number(response.data.works_count ?? 0),
        mostCitedPaperIds,
        recentPaperIds,
      };
    }

    const url = new URL(`${this.baseUrl}/authors`);
    this.applyPoliteQuery(url);
    url.searchParams.set("search", identifier);
    url.searchParams.set("per-page", "1");

    const response = await this.httpClient.requestJson<Record<string, unknown>>(this.provider, url.toString(), {
      headers: this.headers,
      endpointLabel: "openalex:author/search",
      license: "CC0",
    });

    const first = Array.isArray(response.data.results)
      ? (response.data.results[0] as Record<string, unknown> | undefined)
      : undefined;

    if (!first) {
      return null;
    }

    const resolvedId = toCanonicalId(String(first.id ?? ""));
    let mostCitedPaperIds: string[] = [];
    let recentPaperIds: string[] = [];
    try {
      mostCitedPaperIds = await this.fetchAuthorWorkIds(resolvedId, "cited_by_count:desc", 10);
    } catch {
      mostCitedPaperIds = [];
    }
    try {
      recentPaperIds = await this.fetchAuthorWorkIds(resolvedId, "publication_date:desc", 10);
    } catch {
      recentPaperIds = [];
    }

    return {
      id: resolvedId,
      name: String(first.display_name ?? "Unknown"),
      aliases: [],
      affiliation: String(
        ((first.last_known_institutions as Array<Record<string, unknown>> | undefined)?.[0]
          ?.display_name as string | undefined) ?? "",
      ),
      hIndex: Number(first.summary_stats ? (first.summary_stats as Record<string, unknown>).h_index : 0),
      citationCount: Number(first.cited_by_count ?? 0),
      paperCount: Number(first.works_count ?? 0),
      mostCitedPaperIds,
      recentPaperIds,
    };
  }

  async getInstitutionOutput(
    name: string,
    filters: SearchFilters,
  ): Promise<{ institution: CanonicalInstitution | null; papers: CanonicalPaper[] }> {
    const institutionUrl = new URL(`${this.baseUrl}/institutions`);
    this.applyPoliteQuery(institutionUrl);
    institutionUrl.searchParams.set("search", name);
    institutionUrl.searchParams.set("per-page", "1");

    const institutionRes = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      institutionUrl.toString(),
      {
        headers: this.headers,
        endpointLabel: "openalex:institutions/search",
        license: "CC0",
      },
    );

    const firstInstitution = Array.isArray(institutionRes.data.results)
      ? (institutionRes.data.results[0] as Record<string, unknown> | undefined)
      : undefined;

    if (!firstInstitution) {
      return { institution: null, papers: [] };
    }

    const institutionId = toCanonicalId(String(firstInstitution.id ?? ""));
    const worksUrl = new URL(`${this.baseUrl}/works`);
    this.applyPoliteQuery(worksUrl);
    const clauses = [
      `institutions.id:${institutionId}`,
      ...this.buildFilterClauses(filters, false),
    ];
    worksUrl.searchParams.set("filter", clauses.join(","));
    worksUrl.searchParams.set("per-page", String(filters.limit ?? 25));

    const searchTerms = [filters.field, filters.topic].filter(Boolean).join(" ");
    if (searchTerms) {
      worksUrl.searchParams.set("search", searchTerms);
    }

    const worksRes = await this.httpClient.requestJson<Record<string, unknown>>(
      this.provider,
      worksUrl.toString(),
      {
        headers: this.headers,
        endpointLabel: "openalex:institutions/output",
        license: "CC0",
      },
    );

    const papers = Array.isArray(worksRes.data.results)
      ? worksRes.data.results
          .map((work) => mapWorkToPaper(work as Record<string, unknown>))
          .filter((paper) => this.matchesFilters(paper, filters))
          .slice(0, filters.limit ?? 25)
      : [];

    return {
      institution: {
        id: institutionId,
        name: String(firstInstitution.display_name ?? name),
        country: String(firstInstitution.country_code ?? ""),
        paperCount: Number(firstInstitution.works_count ?? 0),
        citationCount: Number(firstInstitution.cited_by_count ?? 0),
      },
      papers,
    };
  }
}
