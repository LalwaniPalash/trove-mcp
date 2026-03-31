import type { CanonicalPaper } from "../types/common.js";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/doi.org\//i, "").trim().toLowerCase();
}

function normalizeArxivId(arxivId: string): string {
  return arxivId.replace(/^arxiv:/i, "").trim().toLowerCase();
}

function isArxivDoi(doi: string | undefined): boolean {
  return Boolean(doi && /^10\.48550\/arxiv\./i.test(normalizeDoi(doi)));
}

export function canonicalPaperId(paper: Pick<CanonicalPaper, "doi" | "arxivId" | "pubmedId" | "s2Id" | "openAlexId" | "title" | "year">): string {
  if (paper.arxivId && isArxivDoi(paper.doi)) {
    return `arxiv:${normalizeArxivId(paper.arxivId)}`;
  }
  if (paper.arxivId && !paper.doi) {
    return `arxiv:${normalizeArxivId(paper.arxivId)}`;
  }
  if (paper.doi) {
    return `doi:${normalizeDoi(paper.doi)}`;
  }
  if (paper.arxivId) {
    return `arxiv:${normalizeArxivId(paper.arxivId)}`;
  }
  if (paper.pubmedId) {
    return `pmid:${paper.pubmedId}`;
  }
  if (paper.s2Id) {
    return `s2:${paper.s2Id.toLowerCase()}`;
  }
  if (paper.openAlexId) {
    return `openalex:${paper.openAlexId.toLowerCase()}`;
  }
  const normalizedTitle = normalizeTitle(paper.title);
  const year = paper.year ?? "unknown";
  return `title:${normalizedTitle}:${year}`;
}

export function paperAliasIds(paper: Pick<CanonicalPaper, "id" | "doi" | "arxivId" | "pubmedId" | "s2Id" | "openAlexId" | "title" | "year">): string[] {
  const aliases = new Set<string>();
  const canonical = canonicalPaperId(paper);
  aliases.add(canonical);

  const add = (value: string | undefined) => {
    if (!value) {
      return;
    }
    aliases.add(value.trim().toLowerCase());
  };

  add(paper.id);

  if (paper.doi) {
    const normalizedDoi = normalizeDoi(paper.doi);
    add(normalizedDoi);
    add(`doi:${normalizedDoi}`);
  }

  if (paper.arxivId) {
    const normalizedArxiv = normalizeArxivId(paper.arxivId);
    add(normalizedArxiv);
    add(`arxiv:${normalizedArxiv}`);
    add(`10.48550/arxiv.${normalizedArxiv}`);
    add(`doi:10.48550/arxiv.${normalizedArxiv}`);
  }

  if (paper.pubmedId) {
    add(paper.pubmedId);
    add(`pmid:${paper.pubmedId}`);
  }

  if (paper.s2Id) {
    add(paper.s2Id);
    add(`s2:${paper.s2Id}`);
  }

  if (paper.openAlexId) {
    const normalizedOpenAlex = paper.openAlexId.trim();
    add(normalizedOpenAlex);
    add(`openalex:${normalizedOpenAlex}`);
  }

  return [...aliases];
}

function betterPaper(base: CanonicalPaper, incoming: CanonicalPaper): CanonicalPaper {
  const merged: CanonicalPaper = {
    ...base,
    ...incoming,
    id: base.id,
    authors: incoming.authors.length > base.authors.length ? incoming.authors : base.authors,
    topics: Array.from(new Set([...base.topics, ...incoming.topics])),
    fields: Array.from(new Set([...base.fields, ...incoming.fields])),
    institutions: Array.from(new Set([...base.institutions, ...incoming.institutions])),
    sourcePriority: Array.from(new Set([...base.sourcePriority, ...incoming.sourcePriority])),
  };

  if ((incoming.abstract?.length ?? 0) < (base.abstract?.length ?? 0)) {
    merged.abstract = base.abstract;
  }

  if ((incoming.citationCount ?? 0) < (base.citationCount ?? 0)) {
    merged.citationCount = base.citationCount;
  }

  if (!incoming.pdfUrl && base.pdfUrl) {
    merged.pdfUrl = base.pdfUrl;
  }

  if (!incoming.url && base.url) {
    merged.url = base.url;
  }

  return merged;
}

export function dedupePapers(papers: CanonicalPaper[]): CanonicalPaper[] {
  const index = new Map<string, CanonicalPaper>();

  for (const paper of papers) {
    const key = canonicalPaperId(paper);
    const existing = index.get(key);
    if (!existing) {
      index.set(key, { ...paper, id: key });
      continue;
    }
    index.set(key, betterPaper(existing, { ...paper, id: key }));
  }

  return [...index.values()];
}
