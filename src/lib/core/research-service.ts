import { canonicalPaperId, dedupePapers } from "./dedupe.js";
import { makeEnvelope } from "./envelope.js";
import { parseIdentifier } from "./identifiers.js";
import { toErrorMessage } from "./errors.js";
import { OpenAlexAdapter } from "../adapters/openalex.js";
import { SemanticScholarAdapter } from "../adapters/semantic-scholar.js";
import { ArxivAdapter } from "../adapters/arxiv.js";
import { UnpaywallAdapter } from "../adapters/unpaywall.js";
import { PubMedAdapter } from "../adapters/pubmed.js";
import { CoreAdapter } from "../adapters/core.js";
import { HuggingFaceAdapter } from "../adapters/huggingface.js";
import { rankPapers } from "../ranking/scorer.js";
import { TroveRepository } from "../db/repository.js";
import { Logger } from "./logger.js";
import { cacheKey } from "../utils/cache-key.js";
import { extractPdfText, toFullTextPayload } from "../fulltext/extractor.js";
import type {
  CanonicalAuthor,
  CanonicalInstitution,
  CanonicalPaper,
  ComparePapersPayload,
  Envelope,
  FullTextPayload,
  LiteratureMap,
  ProviderName,
  SearchFilters,
  SearchResult,
  TraceIdeaPayload,
} from "../types/common.js";
import {
  buildLiteratureMap,
  comparePapers,
  conceptRelevanceScore,
  traceIdea,
} from "../synthesis/analysis.js";
import type { HttpClient } from "../utils/http.js";

const SEARCH_CACHE_MS = 10 * 60 * 1000;
const LITERATURE_MAP_TIMEOUT_MS = 45_000;
const STOPWORDS = new Set([
  "about",
  "among",
  "analysis",
  "approach",
  "attention",
  "between",
  "from",
  "into",
  "large",
  "mechanism",
  "method",
  "model",
  "models",
  "neural",
  "paper",
  "prompting",
  "reasoning",
  "review",
  "study",
  "survey",
  "systems",
  "their",
  "these",
  "toward",
  "using",
  "with",
]);

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distinctiveTokens(text: string | undefined): string[] {
  return Array.from(
    new Set(
      normalizeText(text)
        .split(" ")
        .filter((token) => token.length >= 5 && !STOPWORDS.has(token)),
    ),
  );
}

function titleAbstractAlignmentScore(paper: CanonicalPaper): number {
  const titleTokens = distinctiveTokens(paper.title);
  if (titleTokens.length === 0) {
    return 1;
  }

  const haystack = normalizeText(
    `${paper.abstract ?? ""} ${paper.topics.join(" ")} ${paper.fields.join(" ")}`,
  );
  const hits = titleTokens.filter((token) => haystack.includes(token)).length;
  return hits / Math.min(titleTokens.length, 4);
}

function extractArxivIdFromText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const doiMatch = trimmed.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5}(v\d+)?)$/i);
  if (doiMatch) {
    return doiMatch[1].toLowerCase();
  }

  const absMatch = trimmed.match(/^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(v\d+)?)$/i);
  if (absMatch) {
    return absMatch[1].toLowerCase();
  }

  const pdfMatch = trimmed.match(/^https?:\/\/arxiv\.org\/pdf\/(\d{4}\.\d{4,5}(v\d+)?)(\.pdf)?$/i);
  if (pdfMatch) {
    return pdfMatch[1].toLowerCase();
  }

  const directMatch = trimmed.match(/(\d{4}\.\d{4,5}(v\d+)?)/i);
  if (directMatch) {
    return directMatch[1].toLowerCase();
  }

  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function provenance(source: ProviderName, endpoint: string, cached = false) {
  return {
    source,
    endpoint,
    timestamp: new Date().toISOString(),
    cached,
    license: "see-source-terms",
    latency_ms: 0,
  };
}

export class ResearchService {
  constructor(
    private readonly repo: TroveRepository,
    private readonly logger: Logger,
    private readonly httpClient: HttpClient,
    private readonly version: string,
    private readonly openAlex: OpenAlexAdapter,
    private readonly semantic: SemanticScholarAdapter,
    private readonly arxiv: ArxivAdapter,
    private readonly unpaywall: UnpaywallAdapter,
    private readonly pubmed: PubMedAdapter,
    private readonly core: CoreAdapter,
    private readonly huggingFace: HuggingFaceAdapter,
  ) {}

  getVersion(): string {
    return this.version;
  }

  private sourceWarning(source: ProviderName, action: string, error: unknown): string {
    const message = `${source} ${action} failed: ${toErrorMessage(error)}`;
    this.logger.warn(message);
    return message;
  }

  private addWarning(warnings: string[], message: string): void {
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
  }

  private markSourceOk(source: ProviderName): void {
    this.repo.markSourceOk(source);
  }

  private markSourceError(source: ProviderName, message: string): void {
    this.repo.markSourceError(source, message);
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      normalizeText(text)
        .split(" ")
        .filter((token) => token.length > 2),
    );
  }

  private lexicalSimilarity(base: CanonicalPaper, candidate: CanonicalPaper): number {
    const baseTokens = this.tokenize(`${base.title} ${base.abstract ?? ""} ${base.topics.join(" ")}`);
    const candidateTokens = this.tokenize(
      `${candidate.title} ${candidate.abstract ?? ""} ${candidate.topics.join(" ")}`,
    );

    if (baseTokens.size === 0 || candidateTokens.size === 0) {
      return 0;
    }

    let overlap = 0;
    for (const token of baseTokens) {
      if (candidateTokens.has(token)) {
        overlap += 1;
      }
    }

    const ratio = overlap / Math.max(baseTokens.size, 1);
    const citationBoost = Math.log10((candidate.citationCount ?? 0) + 1) / 5;
    return Number((ratio + citationBoost).toFixed(4));
  }

  private authorOverlapRatio(a: CanonicalPaper, b: CanonicalPaper): number {
    const left = new Set(
      a.authors
        .map((author) => normalizeText(author.name))
        .filter((name) => name.length > 0),
    );
    const right = new Set(
      b.authors
        .map((author) => normalizeText(author.name))
        .filter((name) => name.length > 0),
    );
    if (left.size === 0 || right.size === 0) {
      return 0;
    }

    let overlap = 0;
    for (const name of left) {
      if (right.has(name)) {
        overlap += 1;
      }
    }
    return overlap / Math.max(left.size, right.size);
  }

  private pickBestOpenAlexMatch(queryPaper: CanonicalPaper, candidates: CanonicalPaper[]): CanonicalPaper | null {
    const normalizedTitle = normalizeText(queryPaper.title);
    const queryYear = queryPaper.year ?? 0;
    const queryHasAuthors = queryPaper.authors.length > 0;

    const scored = candidates.map((candidate) => {
      const title = normalizeText(candidate.title);
      const titleExact = title === normalizedTitle ? 1 : 0;
      const lexical = this.lexicalSimilarity(queryPaper, candidate);
      const yearPenalty = queryYear && candidate.year ? Math.min(Math.abs(queryYear - candidate.year), 10) : 4;
      const authorOverlap = this.authorOverlapRatio(queryPaper, candidate);
      const score = titleExact * 5 + lexical * 3 + authorOverlap * 2.5 - yearPenalty * 0.08;
      return { candidate, score, titleExact, lexical, authorOverlap, yearPenalty };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) {
      return null;
    }

    const titleNear = best.lexical >= 0.55;
    const yearNear = best.yearPenalty <= 2;
    const authorsNear = best.authorOverlap >= 0.2;
    const confident =
      best.titleExact === 1 ||
      (titleNear && yearNear && (!queryHasAuthors || authorsNear)) ||
      best.score >= 3.6;

    return confident ? best.candidate : null;
  }

  private mergePaperIdentity(base: CanonicalPaper, resolved: CanonicalPaper): CanonicalPaper {
    const merged: CanonicalPaper = {
      ...base,
      openAlexId: base.openAlexId ?? resolved.openAlexId,
      doi: base.doi ?? resolved.doi,
      s2Id: base.s2Id ?? resolved.s2Id,
      arxivId: base.arxivId ?? resolved.arxivId,
      pubmedId: base.pubmedId ?? resolved.pubmedId,
      title: base.title || resolved.title,
      year: base.year ?? resolved.year,
    };
    this.repo.upsertPaper(merged);
    return merged;
  }

  private async resolveOpenAlexIdentity(paper: CanonicalPaper): Promise<CanonicalPaper> {
    if (paper.openAlexId) {
      return paper;
    }

    let resolved: CanonicalPaper | null = null;
    if (paper.doi) {
      resolved = await this.openAlex.getPaperByIdentifier(paper.doi);
    }

    if (!resolved && paper.arxivId) {
      resolved = await this.openAlex.getPaperByIdentifier(`10.48550/arXiv.${paper.arxivId}`);
    }

    if (!resolved && paper.title) {
      const search = await this.openAlex.searchPapers(paper.title, { limit: 25 });
      resolved = this.pickBestOpenAlexMatch(paper, search.papers);
    }

    if (!resolved || !resolved.openAlexId) {
      return paper;
    }

    return this.mergePaperIdentity(paper, resolved);
  }

  private async enrichPaperIdentity(paper: CanonicalPaper): Promise<CanonicalPaper> {
    let working = paper;

    try {
      working = await this.resolveOpenAlexIdentity(working);
    } catch {
      // Ignore and keep best-effort identity.
    }

    if (!working.s2Id) {
      const handles: string[] = [];
      if (working.doi) {
        handles.push(`DOI:${working.doi}`);
      }
      if (working.arxivId) {
        handles.push(`ARXIV:${working.arxivId}`);
      }

      for (const handle of handles) {
        try {
          const resolved = await this.semantic.getPaper(handle);
          if (resolved) {
            working = {
              ...working,
              s2Id: working.s2Id ?? resolved.s2Id,
              citationCount: working.citationCount ?? resolved.citationCount,
              referenceCount: working.referenceCount ?? resolved.referenceCount,
            };
            break;
          }
        } catch {
          // Ignore and keep best-effort identity.
        }
      }
    }

    this.repo.upsertPaper(working);
    const canonical = this.repo.getPaperByIdentifier(working.id);
    return canonical ?? working;
  }

  private semanticReferenceHandles(paper: CanonicalPaper): string[] {
    const handles: string[] = [];
    if (paper.s2Id) {
      handles.push(paper.s2Id);
    }
    if (paper.doi) {
      handles.push(`DOI:${paper.doi}`);
    }
    if (paper.arxivId) {
      handles.push(`ARXIV:${paper.arxivId}`);
    }
    return Array.from(new Set(handles));
  }

  private isPlausibleReferencePaper(paper: CanonicalPaper): boolean {
    const title = paper.title.trim();
    if (title.length < 8 || /^untitled$/i.test(title)) {
      return false;
    }

    if (!paper.abstract || paper.abstract.trim().length < 40) {
      return true;
    }

    const titleTokens = distinctiveTokens(paper.title);
    const alignment = titleAbstractAlignmentScore(paper);
    if (titleTokens.length >= 3) {
      return alignment >= 0.5;
    }
    return alignment >= 0.34;
  }

  private async validateOpenAlexReferences(references: CanonicalPaper[]): Promise<{
    valid: CanonicalPaper[];
    dropped: CanonicalPaper[];
  }> {
    const valid: CanonicalPaper[] = [];
    const dropped: CanonicalPaper[] = [];

    for (const reference of references) {
      if (!this.isPlausibleReferencePaper(reference)) {
        dropped.push(reference);
        continue;
      }

      try {
        const resolved = await this.resolveOpenAlexIdentity(reference);
        if (!this.isPlausibleReferencePaper(resolved)) {
          dropped.push(reference);
          continue;
        }
        valid.push(resolved);
      } catch {
        valid.push(reference);
      }
    }

    return {
      valid: dedupePapers(valid),
      dropped,
    };
  }

  private async resolveTrendingCandidate(paper: CanonicalPaper): Promise<CanonicalPaper> {
    let working = paper;

    if (!working.citationCount || !working.openAlexId || !working.s2Id) {
      working = await this.enrichPaperIdentity(working);
    }

    if ((working.citationCount ?? 0) === 0 && working.doi) {
      try {
        const openAlexByDoi = await this.openAlex.getPaperByIdentifier(working.doi);
        if (openAlexByDoi) {
          working = {
            ...working,
            ...openAlexByDoi,
            id: canonicalPaperId({ ...working, ...openAlexByDoi }),
            sourcePriority: Array.from(new Set([...working.sourcePriority, ...openAlexByDoi.sourcePriority])),
          };
        }
      } catch {
        // Ignore and keep best-effort identity.
      }
    }

    this.repo.upsertPaper(working);
    return this.repo.getPaperByIdentifier(working.id) ?? working;
  }

  private arxivCandidatesFromPaper(paper: CanonicalPaper, identifier: string): string[] {
    const values = [
      paper.arxivId,
      extractArxivIdFromText(paper.pdfUrl),
      extractArxivIdFromText(paper.url),
      extractArxivIdFromText(paper.doi),
      extractArxivIdFromText(identifier),
    ].filter((value): value is string => Boolean(value));

    return Array.from(new Set(values));
  }

  private chooseCanonicalTitleCandidate(titleQuery: string, results: SearchResult[]): CanonicalPaper | null {
    const normalizedQuery = normalizeText(titleQuery);
    if (!results.length) {
      return null;
    }

    const normalizedTitles = results.map((result) => normalizeText(result.paper.title));
    const hasExact = normalizedTitles.some((title) => title === normalizedQuery);
    const exactYears = results
      .filter((result) => normalizeText(result.paper.title) === normalizedQuery)
      .map((result) => result.paper.year)
      .filter((year): year is number => typeof year === "number" && year > 0);
    const stableYear = exactYears.length ? Math.min(...exactYears) : undefined;

    const scored = results.map((result) => {
      const paper = result.paper;
      const title = normalizeText(paper.title);
      const exact = title === normalizedQuery ? 1 : 0;
      const containment = normalizedQuery && title.includes(normalizedQuery) ? 1 : 0;
      const reverseContainment = normalizedQuery && normalizedQuery.includes(title) ? 1 : 0;
      const citations = paper.citationCount ?? 0;
      const year = paper.year ?? 0;
      const sourceBoost = paper.sourcePriority.includes("openalex") ? 2 : 0;
      const yearStability = year > 0 && year <= new Date().getUTCFullYear() + 1 ? 1 : 0;
      const yearDistancePenalty = stableYear && year ? Math.min(Math.abs(year - stableYear), 15) : 0;
      const citationStrength = Math.log10(citations + 1) * 12;
      const score =
        exact * 100 +
        containment * 30 +
        reverseContainment * 10 +
        citationStrength +
        sourceBoost +
        yearStability * 4 -
        yearDistancePenalty * 2 -
        Math.max(0, year - 2025) * 2;

      return { paper, score, exact, citations, year, title };
    });

    scored.sort((a, b) => {
      if (a.exact !== b.exact) {
        return b.exact - a.exact;
      }
      if (hasExact && a.title === normalizedQuery && b.title !== normalizedQuery) {
        return -1;
      }
      if (hasExact && b.title === normalizedQuery && a.title !== normalizedQuery) {
        return 1;
      }
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.citations !== b.citations) {
        return b.citations - a.citations;
      }
      return (a.year || Number.MAX_SAFE_INTEGER) - (b.year || Number.MAX_SAFE_INTEGER);
    });

    return scored[0]?.paper ?? null;
  }

  private hasAnalyzableFullText(payload: FullTextPayload | undefined): boolean {
    if (!payload) {
      return false;
    }
    if (payload.availability !== "full_text") {
      return false;
    }
    const chunks = payload.chunks;
    if (chunks.length < 1) {
      return false;
    }
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    const sentenceChunks = chunks.filter((chunk) => /[.!?]/.test(chunk.text)).length;
    return totalChars >= 1000 && sentenceChunks >= 1;
  }

  private hasMeaningfulTextFallback(paper: CanonicalPaper): boolean {
    const abstract = (paper.abstract ?? "").trim();
    return abstract.length >= 280 && /[.!?]/.test(abstract);
  }

  private isLikelyLegacyFullTextPayload(payload: FullTextPayload): boolean {
    if (payload.availability !== "full_text" || payload.chunks.length === 0) {
      return false;
    }

    const chunks = payload.chunks;
    const microTokenChunks = chunks.filter((chunk) => chunk.tokenEstimate <= 5).length;
    const tinyTextChunks = chunks.filter((chunk) => chunk.text.trim().length <= 24).length;
    const headerNoiseChunks = chunks.filter((chunk) =>
      /\b(@|university|institute|google research|copyright|arxiv)\b/i.test(chunk.text),
    ).length;
    const truncatedAtMax = payload.truncation.returnedChunks >= payload.truncation.maxChunks;

    const microRatio = microTokenChunks / chunks.length;
    const tinyRatio = tinyTextChunks / chunks.length;
    const noiseRatio = headerNoiseChunks / chunks.length;

    return (
      truncatedAtMax &&
      (microRatio >= 0.25 || tinyRatio >= 0.25 || noiseRatio >= 0.35)
    );
  }

  private hasMapExtractionQuality(map: LiteratureMap): boolean {
    if (map.keyClaims.length < 3 || map.methods.length < 2) {
      return false;
    }
    const noisyClaims = map.keyClaims.filter((claim) => {
      const text = claim.claim.toLowerCase();
      return (
        /\.{2,}/.test(text) ||
        /(^|\s)(figure|table|appendix)\s*\d+/.test(text) ||
        /(^|\s)\d+(\.\d+)+/.test(text)
      );
    });
    return noisyClaims.length <= Math.floor(map.keyClaims.length * 0.15);
  }

  async searchPapers(query: string, filters: SearchFilters): Promise<Envelope<{ results: SearchResult[] }>> {
    try {
      const key = cacheKey("search", { query, filters });
      const cached = this.repo.getCache<SearchResult[]>(key);
      if (cached && cached.expiresAtEpochMs > Date.now()) {
        return makeEnvelope({
          data: { results: cached.value },
          warnings: [],
          provenance: [provenance("openalex", "cache:search", true)],
        });
      }

      const warnings: string[] = [];
      const collected: CanonicalPaper[] = [];

      const sources: Array<{
        source: ProviderName;
        run: () => Promise<CanonicalPaper[] | { papers: CanonicalPaper[]; warnings?: string[] }>;
      }> = [
        { source: "openalex", run: () => this.openAlex.searchPapers(query, filters) },
        { source: "semantic_scholar", run: () => this.semantic.searchPapers(query, filters) },
        { source: "arxiv", run: () => this.arxiv.searchPapers(query, filters.limit ?? 25) },
        {
          source: "pubmed",
          run: () => this.pubmed.searchPapers(query, Math.min(filters.limit ?? 25, 25)),
        },
        {
          source: "core",
          run: () => this.core.searchPapers(query, Math.min(filters.limit ?? 25, 25)),
        },
      ];

      const tasks = await Promise.allSettled(sources.map((source) => source.run()));

      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        const source = sources[i].source;

        if (task.status === "fulfilled") {
          this.markSourceOk(source);

          if (Array.isArray((task.value as { papers?: CanonicalPaper[] }).papers)) {
            collected.push(...((task.value as { papers: CanonicalPaper[] }).papers ?? []));
          } else if (Array.isArray(task.value)) {
            collected.push(...(task.value as CanonicalPaper[]));
          }

          if (Array.isArray((task.value as { warnings?: string[] }).warnings)) {
            for (const warning of (task.value as { warnings: string[] }).warnings ?? []) {
              this.addWarning(warnings, warning);
            }
          }
        } else {
          const warning = this.sourceWarning(source, "search", task.reason);
          this.markSourceError(source, warning);
          this.addWarning(warnings, warning);
        }
      }

      const deduped = dedupePapers(collected);
      for (const paper of deduped) {
        this.repo.upsertPaper(paper);
      }

      const ranked = rankPapers(query, deduped, filters);
      this.repo.setCache(key, ranked, SEARCH_CACHE_MS);

      const failures = tasks.filter((task) => task.status === "rejected").length;
      const status = failures === tasks.length ? "error" : warnings.length > 0 ? "partial" : "ok";

      if (ranked.length === 0 && status !== "error") {
        this.addWarning(warnings, "No results returned by currently reachable sources.");
      }

      return makeEnvelope({
        data: { results: ranked },
        status,
        degraded: warnings.length > 0,
        warnings,
        provenance: sources.map((source) => provenance(source.source, "search")),
      });
    } catch (error) {
      const warning = this.sourceWarning("openalex", "search-aggregate", error);
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [warning],
        provenance: [provenance("openalex", "search-aggregate")],
        data: { results: [] },
      });
    }
  }

  async getTrendingPapers(
    topic: string,
    daysBack: number,
  ): Promise<Envelope<{
      topic: string;
      daysBack: number;
      mode: "snapshot" | "unavailable";
      snapshot_coverage?: {
        candidate_count: number;
        deduped_count: number;
        snapshot_backed_count: number;
        non_zero_velocity_count: number;
        days_back: number;
        bootstrap_started: boolean;
        sources: Array<{
          source: "openalex" | "semantic_scholar" | "huggingface";
          candidate_count: number;
          snapshotable_count: number;
          snapshot_backed_count: number;
          non_zero_velocity_count: number;
          warnings: string[];
        }>;
      };
      results: SearchResult[];
    }>> {
    const warnings: string[] = [];
    const provenanceEntries: ReturnType<typeof provenance>[] = [];
    const sourceDiagnostics: Array<{
      source: "openalex" | "semantic_scholar" | "huggingface";
      candidate_count: number;
      snapshotable_count: number;
      snapshot_backed_count: number;
      non_zero_velocity_count: number;
      warnings: string[];
    }> = [];

    const sources: Array<{
      source: "openalex" | "semantic_scholar" | "huggingface";
      run: () => Promise<{ papers: CanonicalPaper[]; warnings: string[] }>;
    }> = [
      {
        source: "openalex",
        run: () => this.openAlex.searchPapers(topic, { limit: 20 }),
      },
      {
        source: "semantic_scholar",
        run: () => this.semantic.searchPapers(topic, { limit: 20 }),
      },
      {
        source: "huggingface",
        run: async () => ({
          papers: await this.huggingFace.searchPapers(topic, 20),
          warnings: [],
        }),
      },
    ];

    const tasks = await Promise.allSettled(sources.map((source) => source.run()));
    const resolvedCache = new Map<string, Promise<CanonicalPaper>>();
    const resolvedCandidates: CanonicalPaper[] = [];
    let bootstrapStarted = false;

    for (let i = 0; i < tasks.length; i += 1) {
      const source = sources[i];
      const sourceWarnings: string[] = [];
      let sourcePapers: CanonicalPaper[] = [];

      const task = tasks[i];
      if (task.status === "fulfilled") {
        this.markSourceOk(source.source);
        sourcePapers = task.value.papers;
        for (const warning of task.value.warnings) {
          this.addWarning(warnings, warning);
          sourceWarnings.push(warning);
        }
      } else {
        const warning = this.sourceWarning(source.source, "trending-candidates", task.reason);
        this.markSourceError(source.source, warning);
        this.addWarning(warnings, warning);
        sourceWarnings.push(warning);
      }

      provenanceEntries.push(provenance(source.source, "trending:candidates"));

      const sourceResolved: CanonicalPaper[] = [];
      for (const paper of sourcePapers) {
        const key = canonicalPaperId(paper);
        let promise = resolvedCache.get(key);
        if (!promise) {
          promise = this.resolveTrendingCandidate(paper);
          resolvedCache.set(key, promise);
        }
        const resolved = await promise;
        sourceResolved.push(resolved);
        resolvedCandidates.push(resolved);

        if (typeof resolved.citationCount === "number") {
          const beforeCount = this.repo.getCitationSnapshotCount(resolved.id);
          this.repo.saveCitationSnapshot(resolved.id, resolved.citationCount);
          if (beforeCount === 0) {
            bootstrapStarted = true;
          }
        }
      }

      const dedupedSource = dedupePapers(sourceResolved);
      const snapshotableSource = dedupedSource.filter((paper) => typeof paper.citationCount === "number");
      const snapshotBackedSource = snapshotableSource.filter(
        (paper) => this.repo.getCitationSnapshotCount(paper.id) >= 2,
      );
      const nonZeroVelocitySource = snapshotBackedSource.filter(
        (paper) => this.repo.getCitationVelocity(paper.id, daysBack) > 0,
      );

      sourceDiagnostics.push({
        source: source.source,
        candidate_count: sourcePapers.length,
        snapshotable_count: snapshotableSource.length,
        snapshot_backed_count: snapshotBackedSource.length,
        non_zero_velocity_count: nonZeroVelocitySource.length,
        warnings: sourceWarnings,
      });
    }

    const dedupedCandidates = dedupePapers(resolvedCandidates);
    for (const paper of dedupedCandidates) {
      this.repo.upsertPaper(paper);
    }

    const ranked = rankPapers(topic, dedupedCandidates, { limit: 60 });
    const scored = ranked
      .map((result) => {
        const velocity = this.repo.getCitationVelocity(result.paper.id, daysBack);
        return {
          ...result,
          score: Number((result.score + velocity * 1.4).toFixed(2)),
          reasons: [...result.reasons, `velocity:${velocity}`],
        };
      })
      .filter((result) => {
        const velocity = Number(
          result.reasons.find((reason) => reason.startsWith("velocity:"))?.split(":")[1] ?? 0,
        );
        return this.repo.getCitationSnapshotCount(result.paper.id) >= 2 && velocity > 0;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    const coverage = {
      candidate_count: sourceDiagnostics.reduce((sum, source) => sum + source.candidate_count, 0),
      deduped_count: dedupedCandidates.length,
      snapshot_backed_count: dedupedCandidates.filter(
        (paper) => this.repo.getCitationSnapshotCount(paper.id) >= 2,
      ).length,
      non_zero_velocity_count: dedupedCandidates.filter(
        (paper) => this.repo.getCitationVelocity(paper.id, daysBack) > 0,
      ).length,
      days_back: daysBack,
      bootstrap_started: bootstrapStarted,
      sources: sourceDiagnostics,
    };

    if (scored.length === 0) {
      if (coverage.bootstrap_started && coverage.snapshot_backed_count === 0) {
        this.addWarning(
          warnings,
          "Trending bootstrap in progress: this call seeded current citation counts, but short-window trending requires at least one older local snapshot date. Run trove sync or rerun on a later day to accumulate history.",
        );
      }
      this.addWarning(
        warnings,
        "Trending unavailable: insufficient citation snapshot velocity evidence for this topic and window.",
      );
      return makeEnvelope({
        data: {
          topic,
          daysBack,
          mode: "unavailable",
          snapshot_coverage: coverage,
          results: [],
        },
        status: dedupedCandidates.length > 0 ? "partial" : "error",
        degraded: true,
        warnings,
        provenance: provenanceEntries.length
          ? provenanceEntries
          : [provenance("openalex", "trending")],
      });
    }

    return makeEnvelope({
      data: {
        topic,
        daysBack,
        mode: "snapshot",
        snapshot_coverage: coverage,
        results: scored,
      },
      status: warnings.length > 0 ? "partial" : "ok",
      degraded: warnings.length > 0,
      warnings,
      provenance: provenanceEntries.length
        ? provenanceEntries
        : [provenance("openalex", "trending")],
    });
  }

  async getPaper(identifier: string): Promise<Envelope<{ paper: CanonicalPaper | null }>> {
    try {
      const fromCache = this.repo.getPaperByIdentifier(identifier);
      if (fromCache) {
        return makeEnvelope({
          data: { paper: fromCache },
          provenance: [provenance("openalex", "cache:paper", true)],
        });
      }

      const parsed = parseIdentifier(identifier);
      const warnings: string[] = [];
      const provenanceEntries = [] as ReturnType<typeof provenance>[];
      let paper: CanonicalPaper | null = null;

      switch (parsed.type) {
        case "doi":
        case "openalex":
          try {
            paper = await this.openAlex.getPaperByIdentifier(parsed.value);
            this.markSourceOk("openalex");
          } catch (error) {
            const warning = this.sourceWarning("openalex", "get-paper", error);
            this.markSourceError("openalex", warning);
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(provenance("openalex", "paper:get"));

          if (!paper && parsed.type === "doi") {
            try {
              paper = await this.semantic.getPaper(`DOI:${parsed.value}`);
              this.markSourceOk("semantic_scholar");
            } catch (error) {
              const warning = this.sourceWarning("semantic_scholar", "get-paper", error);
              this.markSourceError("semantic_scholar", warning);
              this.addWarning(warnings, warning);
            }
            provenanceEntries.push(provenance("semantic_scholar", "paper:get:fallback"));
          }
          break;
        case "arxiv":
          try {
            paper = await this.arxiv.getPaperByArxivId(parsed.value);
            this.markSourceOk("arxiv");
          } catch (error) {
            const warning = this.sourceWarning("arxiv", "get-paper", error);
            this.markSourceError("arxiv", warning);
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(provenance("arxiv", "paper:get"));

          if (!paper) {
            try {
              paper = await this.openAlex.getPaperByIdentifier(`10.48550/arXiv.${parsed.value}`);
              if (paper) {
                this.markSourceOk("openalex");
              }
            } catch (error) {
              const warning = this.sourceWarning("openalex", "get-paper-arxiv-doi-fallback", error);
              this.markSourceError("openalex", warning);
              this.addWarning(warnings, warning);
            }
            provenanceEntries.push(provenance("openalex", "paper:get:arxiv-doi-fallback"));
          }
          break;
        case "pubmed":
          try {
            paper = await this.pubmed.getPaperByPmid(parsed.value);
            this.markSourceOk("pubmed");
          } catch (error) {
            const warning = this.sourceWarning("pubmed", "get-paper", error);
            this.markSourceError("pubmed", warning);
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(provenance("pubmed", "paper:get"));
          break;
        case "s2":
          try {
            paper = await this.semantic.getPaper(parsed.value);
            this.markSourceOk("semantic_scholar");
          } catch (error) {
            const warning = this.sourceWarning("semantic_scholar", "get-paper", error);
            this.markSourceError("semantic_scholar", warning);
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(provenance("semantic_scholar", "paper:get"));
          break;
        case "title":
        default: {
          const search = await this.searchPapers(parsed.value, { limit: 10 });
          paper = this.chooseCanonicalTitleCandidate(parsed.value, search.data.results);
          for (const warning of search.warnings) {
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(...search.provenance);
          break;
        }
      }

      if (!paper && parsed.type !== "title") {
        try {
          const search = await this.searchPapers(parsed.value, { limit: 5 });
          paper = this.chooseCanonicalTitleCandidate(parsed.value, search.data.results);
          for (const warning of search.warnings) {
            this.addWarning(warnings, warning);
          }
          provenanceEntries.push(...search.provenance);
        } catch (error) {
          this.addWarning(warnings, this.sourceWarning("openalex", "get-paper-fallback-search", error));
        }
      }

      if (paper) {
        this.repo.upsertPaper(paper);
      } else if (!warnings.length) {
        this.addWarning(warnings, "Paper could not be resolved by reachable providers.");
      }

      return makeEnvelope({
        data: { paper },
        status: paper ? (warnings.length ? "partial" : "ok") : "error",
        degraded: warnings.length > 0 || !paper,
        warnings,
        provenance: provenanceEntries,
      });
    } catch (error) {
      return makeEnvelope({
        data: { paper: null },
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "get-paper", error)],
        provenance: [provenance("openalex", "paper:get")],
      });
    }
  }

  async getFullText(identifier: string): Promise<Envelope<{ fullText: FullTextPayload }>> {
    try {
      const paperEnvelope = await this.getPaper(identifier);
      const paper = paperEnvelope.data.paper;
      if (!paper) {
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings: ["Paper not found"],
          provenance: paperEnvelope.provenance,
          data: {
            fullText: {
              paperId: identifier,
              source: "none",
              availability: "unavailable",
              truncation: { truncated: false, maxChunks: 20, returnedChunks: 0 },
              chunks: [],
            },
          },
        });
      }

      const warnings: string[] = [...paperEnvelope.warnings];
      const cached = this.repo.getFullText(paper.id);
      if (cached) {
        if (!this.isLikelyLegacyFullTextPayload(cached)) {
          return makeEnvelope({
            data: { fullText: cached },
            provenance: [provenance("openalex", "cache:fulltext", true)],
          });
        }
        this.repo.deleteFullText(paper.id);
        this.addWarning(
          warnings,
          "Cached full text failed quality checks and was refreshed from source.",
        );
      }

      const fullTextProvenance: ReturnType<typeof provenance>[] = [];
      let extraction = null as Awaited<ReturnType<typeof extractPdfText>>;

      const arxivCandidates = this.arxivCandidatesFromPaper(paper, identifier);
      for (const arxivId of arxivCandidates) {
        extraction = await extractPdfText(
          this.httpClient,
          "arxiv",
          `https://arxiv.org/pdf/${arxivId}.pdf`,
        );
        fullTextProvenance.push(provenance("arxiv", "fulltext:arxiv"));
        if (extraction) {
          this.markSourceOk("arxiv");
          break;
        }
      }

      if (!extraction && arxivCandidates.length > 0) {
        this.addWarning(
          warnings,
          "arXiv full-text PDF could not be parsed; trying Unpaywall and CORE.",
        );
      }

      if (!extraction && paper.doi) {
        if (!this.unpaywall.isConfigured()) {
          this.addWarning(
            warnings,
            "UNPAYWALL_EMAIL (or TROVE_CONTACT_EMAIL) is not set; Unpaywall fallback skipped.",
          );
        } else {
          try {
            const unpaywall = await this.unpaywall.getByDoi(paper.doi);
            fullTextProvenance.push(provenance("unpaywall", "fulltext:unpaywall"));
            this.markSourceOk("unpaywall");
            if (unpaywall?.bestPdfUrl) {
              extraction = await extractPdfText(this.httpClient, "unpaywall", unpaywall.bestPdfUrl);
              if (!extraction) {
                this.addWarning(
                  warnings,
                  "Unpaywall provided a PDF URL but extraction failed.",
                );
              }
            } else {
              this.addWarning(warnings, "Unpaywall returned no PDF for this DOI.");
            }
          } catch (error) {
            const warning = this.sourceWarning("unpaywall", "full-text-lookup", error);
            this.markSourceError("unpaywall", warning);
            this.addWarning(warnings, warning);
          }
        }
      }

      if (!extraction && paper.doi) {
        try {
          const corePdf = await this.core.findPdfByDoi(paper.doi);
          fullTextProvenance.push(provenance("core", "fulltext:core"));
          this.markSourceOk("core");
          if (corePdf) {
            extraction = await extractPdfText(this.httpClient, "core", corePdf);
            if (!extraction) {
              this.addWarning(
                warnings,
                "CORE provided a PDF URL but extraction failed.",
              );
            }
          } else {
            this.addWarning(warnings, "CORE fallback returned no usable PDF.");
          }
        } catch (error) {
          const warning = this.sourceWarning("core", "full-text-lookup", error);
          this.markSourceError("core", warning);
          this.addWarning(warnings, warning);
        }
      }

      if (!extraction) {
        this.addWarning(warnings, "No full-text PDF source could be resolved.");
      }

      const payload = toFullTextPayload(paper.id, extraction, paper.abstract);
      this.repo.upsertFullText(payload);

      const isOk = payload.availability === "full_text" && warnings.length === 0;

      return makeEnvelope({
        data: { fullText: payload },
        status: isOk ? "ok" : "partial",
        degraded: !isOk,
        warnings,
        provenance: [
          ...(paperEnvelope.provenance ?? []),
          ...fullTextProvenance,
          provenance(payload.source === "none" ? "openalex" : payload.source, "fulltext:resolve"),
        ],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "get-full-text", error)],
        provenance: [provenance("openalex", "fulltext:resolve")],
        data: {
          fullText: {
            paperId: identifier,
            source: "none",
            availability: "unavailable",
            truncation: { truncated: false, maxChunks: 20, returnedChunks: 0 },
            chunks: [],
          },
        },
      });
    }
  }

  async getCitations(identifier: string, limit: number): Promise<Envelope<{ citations: CanonicalPaper[] }>> {
    try {
      const paperEnvelope = await this.getPaper(identifier);
      const paper = paperEnvelope.data.paper;
      if (!paper) {
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings: ["Paper not found"],
          data: { citations: [] },
        });
      }

      let workingPaper = paper;
      let citations: CanonicalPaper[] = [];
      const warnings: string[] = [...paperEnvelope.warnings];
      const provenanceEntries: ReturnType<typeof provenance>[] = [];

      if (!workingPaper.openAlexId) {
        try {
          workingPaper = await this.resolveOpenAlexIdentity(workingPaper);
        } catch (error) {
          this.addWarning(
            warnings,
            this.sourceWarning("openalex", "resolve-openalex-id-for-citations", error),
          );
        }
      }

      try {
        if (workingPaper.openAlexId) {
          citations = await this.openAlex.getCitations(workingPaper.openAlexId, limit);
          this.markSourceOk("openalex");
          provenanceEntries.push(provenance("openalex", "citations"));
        }
      } catch (error) {
        const warning = this.sourceWarning("openalex", "citations", error);
        this.markSourceError("openalex", warning);
        this.addWarning(warnings, warning);
      }

      if (citations.length === 0) {
        try {
          if (workingPaper.s2Id) {
            citations = await this.semantic.getCitations(workingPaper.s2Id, limit);
            this.markSourceOk("semantic_scholar");
            provenanceEntries.push(provenance("semantic_scholar", "citations"));
          } else if (workingPaper.doi) {
            citations = await this.semantic.getCitations(`DOI:${workingPaper.doi}`, limit);
            this.markSourceOk("semantic_scholar");
            provenanceEntries.push(provenance("semantic_scholar", "citations"));
          }
        } catch (error) {
          const warning = this.sourceWarning("semantic_scholar", "citations", error);
          this.markSourceError("semantic_scholar", warning);
          this.addWarning(warnings, warning);
        }
      }

      citations.forEach((citation) => this.repo.upsertPaper(citation));

      return makeEnvelope({
        data: { citations },
        status: warnings.length ? "partial" : "ok",
        degraded: warnings.length > 0,
        warnings,
        provenance: provenanceEntries.length
          ? provenanceEntries
          : [provenance(workingPaper.openAlexId ? "openalex" : "semantic_scholar", "citations")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "citations", error)],
        data: { citations: [] },
      });
    }
  }

  async getReferences(identifier: string, limit: number): Promise<Envelope<{ references: CanonicalPaper[] }>> {
    try {
      const paperEnvelope = await this.getPaper(identifier);
      const paper = paperEnvelope.data.paper;
      if (!paper) {
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings: ["Paper not found"],
          data: { references: [] },
        });
      }

      let workingPaper = paper;
      let references: CanonicalPaper[] = [];
      const warnings: string[] = [...paperEnvelope.warnings];
      const provenanceEntries: ReturnType<typeof provenance>[] = [];
      let semanticAttemptCount = 0;
      let semantic404Count = 0;
      let openAlexAttempted = false;
      let openAlexReturnedEmpty = false;

      if (!workingPaper.openAlexId) {
        try {
          workingPaper = await this.resolveOpenAlexIdentity(workingPaper);
        } catch (error) {
          this.addWarning(
            warnings,
            this.sourceWarning("openalex", "resolve-openalex-id-for-references", error),
          );
        }
      }

      const semanticHandles = this.semanticReferenceHandles(workingPaper);
      for (const handle of semanticHandles) {
        semanticAttemptCount += 1;
        try {
          references = await this.semantic.getReferences(handle, limit);
          this.markSourceOk("semantic_scholar");
          provenanceEntries.push(provenance("semantic_scholar", `references:${handle}`));
          if (references.length > 0) {
            break;
          }
        } catch (error) {
          const warning = this.sourceWarning("semantic_scholar", `references:${handle}`, error);
          if (warning.includes("error (404)")) {
            semantic404Count += 1;
          }
          this.markSourceError("semantic_scholar", warning);
          this.addWarning(warnings, warning);
        }
      }

      let droppedInvalidReferences = 0;
      if (references.length === 0) {
        try {
          if (workingPaper.openAlexId) {
            openAlexAttempted = true;
            const openAlexReferences = await this.openAlex.getReferences(workingPaper.openAlexId, limit);
            openAlexReturnedEmpty = openAlexReferences.length === 0;
            const validated = await this.validateOpenAlexReferences(openAlexReferences);
            references = validated.valid;
            droppedInvalidReferences = validated.dropped.length;
            this.markSourceOk("openalex");
            provenanceEntries.push(provenance("openalex", "references"));
          }
        } catch (error) {
          const warning = this.sourceWarning("openalex", "references", error);
          this.markSourceError("openalex", warning);
          this.addWarning(warnings, warning);
        }
      }

      if (droppedInvalidReferences > 0) {
        this.addWarning(
          warnings,
          `Dropped ${droppedInvalidReferences} suspicious OpenAlex reference records after integrity validation.`,
        );
      }

      references = dedupePapers(references).slice(0, limit);
      references.forEach((reference) => this.repo.upsertPaper(reference));

      const expectedReferences = Math.max(
        workingPaper.referenceCount ?? 0,
        paper.referenceCount ?? 0,
        workingPaper.arxivId || /^10\.48550\/arxiv\./i.test(workingPaper.doi ?? "") ? 1 : 0,
      );
      if (references.length === 0 && expectedReferences > 0) {
        if (
          semanticAttemptCount > 0 &&
          semantic404Count === semanticAttemptCount &&
          openAlexAttempted &&
          openAlexReturnedEmpty
        ) {
          this.addWarning(
            warnings,
            "Coverage gap: Semantic Scholar does not index this paper for references, and the OpenAlex work record does not expose a reference list. Try get_full_text to inspect inline citations directly.",
          );
        }
        this.addWarning(
          warnings,
          "References unavailable: metadata indicates references exist, but no provider returned retrievable reference records.",
        );
        return makeEnvelope({
          data: { references: [] },
          status: "error",
          degraded: true,
          warnings,
          provenance: provenanceEntries.length
            ? provenanceEntries
            : [provenance(workingPaper.openAlexId ? "openalex" : "semantic_scholar", "references")],
        });
      }

      return makeEnvelope({
        data: { references },
        status: warnings.length || droppedInvalidReferences > 0 ? "partial" : "ok",
        degraded: warnings.length > 0 || droppedInvalidReferences > 0,
        warnings,
        provenance: provenanceEntries.length
          ? provenanceEntries
          : [provenance(workingPaper.openAlexId ? "openalex" : "semantic_scholar", "references")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "references", error)],
        data: { references: [] },
      });
    }
  }

  async findSimilarPapers(identifier: string, limit: number): Promise<Envelope<{ papers: CanonicalPaper[] }>> {
    try {
      const paperEnvelope = await this.getPaper(identifier);
      const paper = paperEnvelope.data.paper;
      if (!paper) {
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings: ["Paper not found"],
          data: { papers: [] },
        });
      }

      if (!this.semantic.hasApiKeyConfigured()) {
        const warnings = [...paperEnvelope.warnings];
        this.addWarning(warnings, this.semantic.reliableRecommendationsWarning());
        return makeEnvelope({
          data: { papers: [] },
          status: "error",
          degraded: true,
          warnings,
          provenance: [provenance("semantic_scholar", "recommendations")],
        });
      }

      const handle = paper.s2Id ? paper.s2Id : paper.doi ? `DOI:${paper.doi}` : identifier;
      const warnings: string[] = [...paperEnvelope.warnings];
      let papers: CanonicalPaper[] = [];
      const provenanceEntries: ReturnType<typeof provenance>[] = [];

      try {
        papers = await this.semantic.findSimilarPapers(handle, limit);
        this.markSourceOk("semantic_scholar");
        provenanceEntries.push(provenance("semantic_scholar", "recommendations"));
      } catch (error) {
        const warning = this.sourceWarning("semantic_scholar", "similar-papers", error);
        this.markSourceError("semantic_scholar", warning);
        this.addWarning(warnings, warning);
      }

      if (papers.length === 0) {
        this.addWarning(
          warnings,
          "Semantic similarity unavailable: Semantic Scholar returned no recommendations or is currently rate-limited.",
        );
        return makeEnvelope({
          data: { papers: [] },
          status: "error",
          degraded: true,
          warnings,
          provenance: provenanceEntries.length
            ? provenanceEntries
            : [provenance("semantic_scholar", "recommendations")],
        });
      }

      papers.forEach((similarPaper) => this.repo.upsertPaper(similarPaper));

      return makeEnvelope({
        data: { papers },
        status: papers.length === 0 ? "error" : warnings.length ? "partial" : "ok",
        degraded: warnings.length > 0 || papers.length === 0,
        warnings,
        provenance: provenanceEntries.length
          ? provenanceEntries
          : [provenance("semantic_scholar", "recommendations")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("semantic_scholar", "similar-papers", error)],
        data: { papers: [] },
        provenance: [provenance("semantic_scholar", "recommendations")],
      });
    }
  }

  async getAuthor(identifier: string): Promise<Envelope<{ author: CanonicalAuthor | null }>> {
    const cached = this.repo.getAuthor(identifier);
    if (cached && !this.authorNeedsWorkListRefresh(cached)) {
      return makeEnvelope({
        data: { author: cached },
        provenance: [provenance("openalex", "cache:author", true)],
      });
    }

    let author: CanonicalAuthor | null = null;
    const warnings: string[] = [];
    const provenanceEntries: ReturnType<typeof provenance>[] = [];
    try {
      author = await this.openAlex.getAuthor(identifier);
      this.markSourceOk("openalex");
      provenanceEntries.push(provenance("openalex", "author:get"));
    } catch (error) {
      const warning = this.sourceWarning("openalex", "author:get", error);
      this.markSourceError("openalex", warning);
      this.addWarning(warnings, warning);
    }

    if (!author) {
      try {
        author = await this.semantic.getAuthor(identifier);
        this.markSourceOk("semantic_scholar");
        provenanceEntries.push(provenance("semantic_scholar", "author:get"));
      } catch (error) {
        const warning = this.sourceWarning("semantic_scholar", "author:get", error);
        this.markSourceError("semantic_scholar", warning);
        this.addWarning(warnings, warning);
      }
    }

    if (author && this.authorNeedsWorkListRefresh(author)) {
      this.addWarning(
        warnings,
        "Author work-list enrichment is best-effort enrichment. OpenAlex resolved the author profile, but mostCitedPaperIds/recentPaperIds could not be populated reliably for this fetch.",
      );
    }

    if (author && !this.authorNeedsWorkListRefresh(author)) {
      this.repo.upsertAuthor(author);
    } else if (!warnings.length) {
      this.addWarning(warnings, "Author could not be resolved by OpenAlex or Semantic Scholar.");
    }

    return makeEnvelope({
      data: { author },
      status: author ? (warnings.length ? "partial" : "ok") : "error",
      degraded: warnings.length > 0 || !author,
      warnings,
      provenance: provenanceEntries.length
        ? provenanceEntries
        : [provenance(author ? "openalex" : "semantic_scholar", "author:get")],
    });
  }

  private authorNeedsWorkListRefresh(author: CanonicalAuthor): boolean {
    if ((author.paperCount ?? 0) <= 0) {
      return false;
    }
    return author.mostCitedPaperIds.length === 0 || author.recentPaperIds.length === 0;
  }

  async getInstitutionOutput(
    institution: string,
    filters: SearchFilters,
  ): Promise<Envelope<{ institution: CanonicalInstitution | null; papers: CanonicalPaper[] }>> {
    try {
      const result = await this.openAlex.getInstitutionOutput(institution, filters);
      for (const paper of result.papers) {
        this.repo.upsertPaper(paper);
      }
      if (result.institution) {
        this.repo.upsertInstitution(result.institution);
      }

      return makeEnvelope({
        data: result,
        provenance: [provenance("openalex", "institution:output")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "institution-output", error)],
        data: { institution: null, papers: [] },
        provenance: [provenance("openalex", "institution:output")],
      });
    }
  }

  async getCoauthorNetwork(authorIdentifier: string): Promise<Envelope<{ author: CanonicalAuthor | null; edges: Array<{ from: string; to: string; weight: number; paperId: string }> }>> {
    try {
      const authorEnvelope = await this.getAuthor(authorIdentifier);
      const author = authorEnvelope.data.author;
      if (!author) {
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings: ["Author not found"],
          data: { author: null, edges: [] },
        });
      }

      const warnings = [...authorEnvelope.warnings];
      if (!/^A\d+$/i.test(author.id)) {
        this.addWarning(
          warnings,
          "Coauthor network unavailable: OpenAlex author ID is required for precision mode.",
        );
        return makeEnvelope({
          status: "error",
          degraded: true,
          warnings,
          data: { author, edges: [] },
          provenance: [provenance("openalex", "coauthor-network")],
        });
      }

      const works = await this.openAlex.getAuthorWorksById(author.id, 50);
      const edgeMap = new Map<string, { from: string; to: string; weight: number; paperId: string }>();
      for (const paper of works) {
        for (const coauthor of paper.authors.slice(0, 25)) {
          const name = coauthor.name.trim();
          if (!name || normalizeText(name) === normalizeText(author.name)) {
            continue;
          }
          const key = normalizeText(name);
          const existing = edgeMap.get(key);
          if (existing) {
            existing.weight += 1;
            continue;
          }
          edgeMap.set(key, {
            from: author.name,
            to: name,
            weight: 1,
            paperId: paper.id,
          });
        }
      }

      const edges = Array.from(edgeMap.values())
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 200);

      return makeEnvelope({
        data: { author, edges },
        status: warnings.length ? "partial" : "ok",
        degraded: warnings.length > 0,
        warnings,
        provenance: [provenance("openalex", "coauthor-network")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "coauthor-network", error)],
        data: { author: null, edges: [] },
        provenance: [provenance("openalex", "coauthor-network")],
      });
    }
  }

  async buildLiteratureMap(query: string, depth: number): Promise<Envelope<{ map: LiteratureMap }>> {
    try {
      const search = await this.searchPapers(query, { limit: Math.max(depth * 8, 20) });
      const warnings = [...search.warnings];
      const relevanceThreshold = 0.2;
      const relevantResults = search.data.results
        .map((result) => ({
          result,
          relevance: conceptRelevanceScore(query, result.paper),
        }))
        .filter((entry) => entry.relevance >= relevanceThreshold)
        .sort((a, b) => b.relevance - a.relevance);

      if (relevantResults.length === 0) {
        this.addWarning(
          warnings,
          "Literature map unavailable: no topically relevant papers passed the quality gate for this query.",
        );
        return makeEnvelope({
          data: {
            map: {
              query,
              depth,
              papers: [],
              keyClaims: [],
              methods: [],
              limitations: [],
              consensus: [],
              contradictions: [],
              influence: [],
            },
          },
          status: "error",
          degraded: true,
          warnings,
          provenance: search.provenance,
        });
      }

      const minRelevant = Math.max(3, depth * 2);
      if (relevantResults.length < minRelevant) {
        this.addWarning(
          warnings,
          "Literature map has reduced evidence coverage: fewer high-confidence relevant papers were found than requested.",
        );
      }
      const papers = dedupePapers(relevantResults.map((entry) => entry.result.paper));

      const fullTextMap: Record<string, FullTextPayload | undefined> = {};
      const deadline = Date.now() + LITERATURE_MAP_TIMEOUT_MS;
      const targets = papers.slice(0, Math.max(depth, 1) * 6);
      let cursor = 0;
      let timedOut = false;
      const workers = Array.from({ length: Math.min(3, targets.length) }, () => (async () => {
        while (true) {
          if (Date.now() >= deadline) {
            timedOut = true;
            return;
          }

          const index = cursor;
          cursor += 1;
          if (index >= targets.length) {
            return;
          }

          const paper = targets[index];
          const remaining = deadline - Date.now();
          if (remaining <= 600) {
            timedOut = true;
            return;
          }

          const perPaperBudget = Math.min(12_000, Math.max(1_500, remaining - 400));
          try {
            const fullText = await withTimeout(
              this.getFullText(paper.id),
              perPaperBudget,
              new Error(`literature-map per-paper timeout for ${paper.id}`),
            );
            fullTextMap[paper.id] = fullText.data.fullText;
            for (const warning of fullText.warnings) {
              this.addWarning(warnings, warning);
            }
          } catch (error) {
            if (String(error).toLowerCase().includes("timeout")) {
              timedOut = true;
            }
            this.addWarning(
              warnings,
              `full-text fetch failed for ${paper.id}: ${toErrorMessage(error)}`,
            );
          }
        }
      })());

      await Promise.all(workers);

      if (timedOut) {
        this.addWarning(
          warnings,
          "build_literature_map reached 45s deadline; returned partial structured map.",
        );
      }

      const analyzable = targets.filter(
        (paper) =>
          this.hasAnalyzableFullText(fullTextMap[paper.id]) || this.hasMeaningfulTextFallback(paper),
      );
      if (analyzable.length === 0) {
        this.addWarning(
          warnings,
          "Literature map unavailable: insufficient high-quality evidence for reliable structured extraction.",
        );
        return makeEnvelope({
          data: {
            map: {
              query,
              depth,
              papers: [],
              keyClaims: [],
              methods: [],
              limitations: [],
              consensus: [],
              contradictions: [],
              influence: [],
            },
          },
          status: "error",
          degraded: true,
          warnings,
          provenance: search.provenance,
        });
      }

      const map = buildLiteratureMap(query, depth, dedupePapers(analyzable), fullTextMap);
      const insufficientCoverage = analyzable.length < Math.max(2, Math.ceil(targets.length * 0.5));
      const lowExtractionQuality = !this.hasMapExtractionQuality(map);
      if (insufficientCoverage || lowExtractionQuality) {
        this.addWarning(
          warnings,
          "Literature map returned partial evidence because coverage or extraction quality is below the preferred threshold.",
        );
      }

      return makeEnvelope({
        data: { map },
        status: warnings.length || insufficientCoverage || lowExtractionQuality ? "partial" : search.status,
        degraded: warnings.length > 0 || search.degraded,
        warnings,
        provenance: search.provenance,
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "build-literature-map", error)],
        data: {
          map: {
            query,
            depth,
            papers: [],
            keyClaims: [],
            methods: [],
            limitations: [],
            consensus: [],
            contradictions: [],
            influence: [],
          },
        },
        provenance: [provenance("openalex", "build-literature-map")],
      });
    }
  }

  async comparePapers(paperIdentifiers: string[]): Promise<Envelope<{ comparison: ComparePapersPayload }>> {
    try {
      const papers: CanonicalPaper[] = [];
      const warnings: string[] = [];

      for (const id of paperIdentifiers) {
        const paper = await this.getPaper(id);
        if (paper.data.paper) {
          papers.push(paper.data.paper);
          for (const warning of paper.warnings) {
            this.addWarning(warnings, warning);
          }
        } else {
          this.addWarning(warnings, `Paper not found: ${id}`);
        }
      }

      if (papers.length !== paperIdentifiers.length) {
        this.addWarning(
          warnings,
          "Comparison unavailable: one or more requested papers could not be resolved.",
        );
        return makeEnvelope({
          data: { comparison: { papers: [] } },
          status: "error",
          degraded: true,
          warnings,
          provenance: [provenance("openalex", "compare-papers"), provenance("semantic_scholar", "compare-papers")],
        });
      }

      const fullTexts: Record<string, FullTextPayload | undefined> = {};
      for (const paper of papers) {
        const fullText = await this.getFullText(paper.id);
        fullTexts[paper.id] = fullText.data.fullText;
        for (const warning of fullText.warnings) {
          this.addWarning(warnings, warning);
        }
      }

      const insufficientEvidence = papers
        .filter((paper) => {
          const payload = fullTexts[paper.id];
          return !this.hasAnalyzableFullText(payload) && !this.hasMeaningfulTextFallback(paper);
        })
        .map((paper) => paper.id);

      if (insufficientEvidence.length > 0) {
        this.addWarning(
          warnings,
          `Comparison unavailable: insufficient analyzable evidence for papers ${insufficientEvidence.join(", ")}.`,
        );
        return makeEnvelope({
          data: { comparison: { papers: [] } },
          status: "error",
          degraded: true,
          warnings,
          provenance: [provenance("openalex", "compare-papers"), provenance("semantic_scholar", "compare-papers")],
        });
      }

      const comparison = comparePapers(papers, fullTexts);
      const malformed = comparison.papers.filter(
        (record) =>
          record.methodology.length === 0 &&
          record.findings.length === 0 &&
          record.limitations.length === 0 &&
          record.reproducibilitySignals.length === 0,
      );
      if (malformed.length > 0) {
        this.addWarning(
          warnings,
          `Comparison unavailable: extraction quality too low for papers ${malformed.map((r) => r.paper.id).join(", ")}.`,
        );
        return makeEnvelope({
          data: { comparison: { papers: [] } },
          status: "error",
          degraded: true,
          warnings,
          provenance: [provenance("openalex", "compare-papers"), provenance("semantic_scholar", "compare-papers")],
        });
      }

      return makeEnvelope({
        data: { comparison },
        status: warnings.length ? "partial" : "ok",
        degraded: warnings.length > 0,
        warnings,
        provenance: [provenance("openalex", "compare-papers"), provenance("semantic_scholar", "compare-papers")],
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "compare-papers", error)],
        data: { comparison: { papers: [] } },
        provenance: [provenance("openalex", "compare-papers")],
      });
    }
  }

  async traceIdea(concept: string, fromYear?: number): Promise<Envelope<{ trace: TraceIdeaPayload }>> {
    try {
      const search = await this.searchPapers(concept, { limit: 80, year_min: fromYear });
      const papers = search.data.results.map((result) => result.paper);
      const trace = traceIdea(concept, fromYear, papers);
      const warnings = [...search.warnings];

      const topRelevance = trace.originCandidates.length
        ? conceptRelevanceScore(concept, trace.originCandidates[0])
        : 0;

      if (topRelevance < 0.2) {
        this.addWarning(
          warnings,
          "Low concept relevance confidence in trace_idea output; verify origin candidates manually.",
        );
      }

      return makeEnvelope({
        data: { trace },
        status: warnings.length ? "partial" : search.status,
        degraded: search.degraded || warnings.length > 0,
        warnings,
        provenance: search.provenance,
      });
    } catch (error) {
      return makeEnvelope({
        status: "error",
        degraded: true,
        warnings: [this.sourceWarning("openalex", "trace-idea", error)],
        data: {
          trace: {
            concept,
            fromYear,
            originCandidates: [],
            timeline: [],
            branchingPapers: [],
          },
        },
        provenance: [provenance("openalex", "trace-idea")],
      });
    }
  }

  async syncSnapshots(seedQueries: string[] = ["machine learning", "genomics", "econometrics"]): Promise<{
    syncedPapers: number;
    queries: string[];
    warnings: string[];
  }> {
    const warnings: string[] = [];
    let syncedPapers = 0;

    for (const query of seedQueries) {
      try {
        const envelope = await this.searchPapers(query, { limit: 40 });
        for (const result of envelope.data.results) {
          const count = result.paper.citationCount ?? 0;
          this.repo.saveCitationSnapshot(result.paper.id, count);
          syncedPapers += 1;
        }
      } catch (error) {
        const message = `sync failed for "${query}": ${toErrorMessage(error)}`;
        this.logger.warn(message);
        warnings.push(message);
      }
    }

    return { syncedPapers, queries: seedQueries, warnings };
  }

  getSourceHealth(): Envelope<{ health: ReturnType<TroveRepository["getSourceHealth"]> }> {
    return makeEnvelope({
      data: { health: this.repo.getSourceHealth() },
      provenance: [provenance("openalex", "resource:source-health", true)],
    });
  }

  getCacheStats(): Envelope<{ stats: ReturnType<TroveRepository["getCacheStats"]> }> {
    return makeEnvelope({
      data: { stats: this.repo.getCacheStats() },
      provenance: [provenance("openalex", "resource:cache-stats", true)],
    });
  }
}
