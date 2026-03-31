import type { CanonicalPaper, SearchFilters, SearchResult } from "../types/common.js";

const DEFAULT_LIMIT = 20;
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
  "model",
  "models",
  "neural",
  "paper",
  "study",
  "survey",
  "their",
  "these",
  "using",
  "with",
]);

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function distinctiveTokens(query: string): string[] {
  return Array.from(
    new Set(
      queryTokens(query).filter((term) => term.length >= 5 && !STOPWORDS.has(term)),
    ),
  );
}

function scorePaper(query: string, paper: CanonicalPaper): { score: number; reasons: string[]; eligible: boolean } {
  const reasons: string[] = [];
  let score = 0;

  const queryTerms = queryTokens(query);
  const anchorTerms = distinctiveTokens(query);
  const normalizedQuery = query.toLowerCase().trim();
  const title = paper.title.toLowerCase();
  const abstract = (paper.abstract ?? "").toLowerCase();
  const topicText = `${paper.topics.join(" ")} ${paper.fields.join(" ")}`.toLowerCase();

  const titleHits = queryTerms.filter((term) => title.includes(term)).length;
  const abstractHits = queryTerms.filter((term) => abstract.includes(term)).length;
  const topicHits = queryTerms.filter((term) => topicText.includes(term)).length;
  const anchorHits = anchorTerms.filter((term) => title.includes(term) || abstract.includes(term)).length;
  const anchorTitleHits = anchorTerms.filter((term) => title.includes(term)).length;

  score += titleHits * 10;
  score += abstractHits * 5;
  score += topicHits * 1.5;
  if (titleHits + abstractHits + topicHits > 0) {
    reasons.push(`relevance:${titleHits + abstractHits + topicHits}`);
  }
  if (anchorHits > 0) {
    reasons.push(`anchor_hits:${anchorHits}`);
  }
  if (anchorTitleHits > 0) {
    reasons.push(`anchor_title_hits:${anchorTitleHits}`);
  }

  const phraseHit = normalizedQuery.length >= 8 && (title.includes(normalizedQuery) || abstract.includes(normalizedQuery));
  if (phraseHit) {
    reasons.push("phrase_hit");
  }

  const citations = paper.citationCount ?? 0;
  const citationComponent = Math.log10(citations + 1) * 6;
  score += citationComponent;
  reasons.push(`citations:${citations}`);

  const year = paper.year ?? 0;
  const recency = Math.max(0, year - 2010) * 0.6;
  score += recency;
  reasons.push(`year:${year || "unknown"}`);

  if (paper.openAccess) {
    score += 5;
    reasons.push("open_access");
  }

  if (paper.pdfUrl) {
    score += 4;
    reasons.push("full_text_url");
  }

  const sourceBoost = paper.sourcePriority.includes("openalex") ? 2 : 0;
  score += sourceBoost;

  const minimumAnchorHits = anchorTerms.length >= 3 ? 2 : anchorTerms.length >= 2 ? 1 : 0;
  const hasStrongAnchorPlacement = anchorTerms.length < 3 || anchorTitleHits >= 1;
  const eligible =
    minimumAnchorHits === 0 ||
    phraseHit ||
    (anchorHits >= minimumAnchorHits && hasStrongAnchorPlacement);
  if (!eligible) {
    reasons.push("anchor_miss");
  }

  return { score, reasons, eligible };
}

function matchesFilters(paper: CanonicalPaper, filters: SearchFilters): boolean {
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
    const fields = paper.fields.map((f) => f.toLowerCase());
    if (!fields.some((f) => f.includes(filters.field!.toLowerCase()))) {
      return false;
    }
  }

  if (filters.topic) {
    const topics = paper.topics.map((t) => t.toLowerCase());
    if (!topics.some((t) => t.includes(filters.topic!.toLowerCase()))) {
      return false;
    }
  }

  if (filters.institution) {
    const institutions = paper.institutions.map((i) => i.toLowerCase());
    if (!institutions.some((i) => i.includes(filters.institution!.toLowerCase()))) {
      return false;
    }
  }

  if (filters.author) {
    const authors = paper.authors.map((a) => a.name.toLowerCase());
    if (!authors.some((a) => a.includes(filters.author!.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

export function rankPapers(query: string, papers: CanonicalPaper[], filters: SearchFilters = {}): SearchResult[] {
  const filtered = papers.filter((paper) => matchesFilters(paper, filters));

  return filtered
    .map((paper) => {
      const scored = scorePaper(query, paper);
      return {
        paper,
        score: Number(scored.score.toFixed(2)),
        reasons: scored.reasons,
        eligible: scored.eligible,
      };
    })
    .filter((result) => result.eligible)
    .sort((a, b) => b.score - a.score)
    .map(({ eligible: _eligible, ...result }) => result)
    .slice(0, filters.limit ?? DEFAULT_LIMIT);
}
