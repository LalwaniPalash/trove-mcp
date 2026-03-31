import type {
  CanonicalPaper,
  ComparePapersPayload,
  FullTextPayload,
  LiteratureClaim,
  LiteratureMap,
  TraceIdeaPayload,
} from "../types/common.js";

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40)
    .filter((s) => !isNoiseSentence(s));
}

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickByKeywords(text: string, keywords: string[], limit: number): string[] {
  const all = sentences(text);
  return all
    .filter((s) => keywords.some((k) => s.toLowerCase().includes(k)))
    .filter((s) => s.split(/\s+/).length >= 8)
    .slice(0, limit);
}

function isNoiseSentence(value: string): boolean {
  const s = value.trim();
  if (!s) {
    return true;
  }

  if (/\b(fig(?:ure)?|table|appendix)\s*\d+/i.test(s) && s.length < 120) {
    return true;
  }

  if (/^\s*[\d.\- ]+\s*$/.test(s)) {
    return true;
  }

  if (/\.{2,}/.test(s)) {
    return true;
  }

  if (/\b(arxiv|doi|copyright|all rights reserved)\b/i.test(s)) {
    return true;
  }

  if (/\b\S+@\S+\.\S+\b/.test(s)) {
    return true;
  }

  if (/\b(university|institute|laboratory|department|school of|research center)\b/i.test(s) && s.length < 220) {
    return true;
  }

  const nameLike = s.match(/\b[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+\b/g);
  if (nameLike && nameLike.length >= 4 && s.length < 260) {
    return true;
  }

  if (/[A-Za-z]{0,2}\d{2,}[A-Za-z]{0,2}/.test(s) && s.length < 80) {
    return true;
  }

  return false;
}

function looksLikeFrontMatter(sentence: string, title: string): boolean {
  const sentenceNorm = normalizeText(sentence);
  const titleNorm = normalizeText(title);
  if (titleNorm && sentenceNorm.startsWith(titleNorm)) {
    return true;
  }
  if (sentence.includes("\n") && /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b.*\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(sentence)) {
    return true;
  }
  if (/\b\S+@\S+\.\S+\b/.test(sentence)) {
    return true;
  }
  if (/\b(author|affiliation|corresponding author|accepted at)\b/i.test(sentence) && sentence.length < 260) {
    return true;
  }
  return false;
}

function extractCodeLinks(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  return Array.from(
    new Set(
      urls.filter((url) => /github\.com|gitlab\.com|huggingface\.co/i.test(url)),
    ),
  ).slice(0, 8);
}

function methodFocusedText(paper: CanonicalPaper, fullText?: FullTextPayload): string {
  if (!fullText || fullText.availability !== "full_text") {
    return paper.abstract ?? "";
  }

  const methodChunks = fullText.chunks.filter((chunk) => {
    const heading = (chunk.heading ?? "").toLowerCase();
    const prefix = chunk.text.slice(0, 240).toLowerCase();
    if (looksLikeFrontMatter(chunk.text.slice(0, 280), paper.title)) {
      return false;
    }
    return (
      /\b(method|approach|training|implementation|experimental setup|model|algorithm|preference|optimization)\b/.test(heading) ||
      /\b(we propose|our method|architecture|training setup|we train|we fine tune|we fine-tune|we optimize|we collect|we use)\b/.test(prefix)
    );
  });

  if (!methodChunks.length) {
    return fullText.chunks
      .filter((chunk) => !looksLikeFrontMatter(chunk.text.slice(0, 280), paper.title))
      .slice(0, 6)
      .map((chunk) => chunk.text)
      .join(" ");
  }

  return methodChunks.map((chunk) => chunk.text).join(" ");
}

function sanitizeExtracted(items: string[], paper: CanonicalPaper): string[] {
  return Array.from(
    new Set(items.filter((item) => !looksLikeFrontMatter(item, paper.title))),
  );
}

export function extractClaims(paper: CanonicalPaper, fullText?: FullTextPayload): LiteratureClaim[] {
  const sourceText = fullText?.chunks.map((chunk) => chunk.text).join(" ") || paper.abstract || "";
  const claims = pickByKeywords(
    sourceText,
    [
      "we show",
      "we find",
      "results indicate",
      "we demonstrate",
      "our findings",
      "we observe",
      "this suggests",
    ],
    5,
  );

  return claims.map((claim, idx) => ({
    paperId: paper.id,
    claim,
    confidence: Number((0.55 + idx * 0.08).toFixed(2)),
    evidence: fullText ? "full_text" : "abstract",
  }));
}

function extractMethods(text: string): string[] {
  return pickByKeywords(
    text,
    ["we propose", "method", "approach", "framework", "experimental setup", "architecture", "model"],
    4,
  );
}

function extractLimitations(text: string): string[] {
  return pickByKeywords(
    text,
    ["limitation", "however", "future work", "constraint", "bias", "we leave", "remains unclear"],
    4,
  );
}

function consensusAndContradictions(claims: LiteratureClaim[]): { consensus: string[]; contradictions: string[] } {
  const normalized = claims.map((claim) => claim.claim.toLowerCase());
  const consensus: string[] = [];
  const contradictions: string[] = [];

  for (const claim of normalized) {
    if (claim.includes("improve") || claim.includes("effective") || claim.includes("outperform")) {
      consensus.push(claim);
    }
    if (claim.includes("however") || claim.includes("not") || claim.includes("fails")) {
      contradictions.push(claim);
    }
  }

  return {
    consensus: Array.from(new Set(consensus)).slice(0, 10),
    contradictions: Array.from(new Set(contradictions)).slice(0, 10),
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

export function conceptRelevanceScore(concept: string, paper: CanonicalPaper): number {
  const conceptTokens = Array.from(new Set(tokenize(concept)));
  if (conceptTokens.length === 0) {
    return 0;
  }

  const titleTokens = new Set(tokenize(paper.title));
  const abstractTokens = new Set(tokenize(paper.abstract ?? ""));
  const topicTokens = new Set(tokenize(`${paper.topics.join(" ")} ${paper.fields.join(" ")}`));
  const fullText = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  const fullConcept = concept.toLowerCase().trim();

  let overlap = 0;
  for (const token of conceptTokens) {
    if (titleTokens.has(token)) {
      overlap += 1.3;
    } else if (abstractTokens.has(token)) {
      overlap += 1;
    } else if (topicTokens.has(token)) {
      overlap += 0.7;
    }
  }

  const phraseBonus = fullConcept.length > 4 && fullText.includes(fullConcept) ? 0.6 : 0;
  const citationBoost = Math.min(Math.log10((paper.citationCount ?? 0) + 1) / 10, 0.2);
  const normalized = overlap / Math.max(conceptTokens.length * 1.3, 1);
  return Number(Math.min(normalized + phraseBonus + citationBoost, 1).toFixed(4));
}

export function buildLiteratureMap(
  query: string,
  depth: number,
  papers: CanonicalPaper[],
  fullTexts: Record<string, FullTextPayload | undefined>,
): LiteratureMap {
  const selected = papers.slice(0, Math.max(depth, 1) * 6);

  const claims: LiteratureClaim[] = [];
  const methods: Array<{ paperId: string; method: string }> = [];
  const limitations: Array<{ paperId: string; limitation: string }> = [];

  for (const paper of selected) {
    const fullText = fullTexts[paper.id];
    const text = fullText?.chunks.map((chunk) => chunk.text).join(" ") || paper.abstract || "";
    const methodText = methodFocusedText(paper, fullText);

    claims.push(...extractClaims(paper, fullText));

    for (const method of sanitizeExtracted(extractMethods(methodText), paper)) {
      methods.push({ paperId: paper.id, method });
    }

    for (const limitation of sanitizeExtracted(extractLimitations(text), paper)) {
      limitations.push({ paperId: paper.id, limitation });
    }
  }

  const cc = consensusAndContradictions(claims);

  return {
    query,
    depth,
    papers: selected,
    keyClaims: claims.slice(0, 50),
    methods: methods.slice(0, 40),
    limitations: limitations.slice(0, 40),
    consensus: cc.consensus,
    contradictions: cc.contradictions,
    influence: selected
      .map((paper) => ({
        paperId: paper.id,
        score: Number((Math.log10((paper.citationCount ?? 0) + 1) * 10).toFixed(2)),
      }))
      .sort((a, b) => b.score - a.score),
  };
}

export function comparePapers(papers: CanonicalPaper[], fullTexts: Record<string, FullTextPayload | undefined>): ComparePapersPayload {
  return {
    papers: papers.map((paper) => {
      const fullText = fullTexts[paper.id];
      const text = fullText?.chunks.map((chunk) => chunk.text).join(" ") || paper.abstract || "";
      const methodology = sanitizeExtracted(extractMethods(methodFocusedText(paper, fullText)), paper);
      const findings = sanitizeExtracted(
        pickByKeywords(text, ["result", "find", "improve", "accuracy", "effect"], 4),
        paper,
      );
      const limitations = sanitizeExtracted(extractLimitations(text), paper);
      const reproducibilitySignals = sanitizeExtracted(
        pickByKeywords(text, ["code", "dataset", "appendix", "supplementary", "github"], 3),
        paper,
      );
      const codeLinks = extractCodeLinks(`${text}\n${paper.url ?? ""}\n${paper.pdfUrl ?? ""}`);

      return {
        paper,
        methodology,
        findings,
        limitations,
        reproducibilitySignals,
        codeLinks,
      };
    }),
  };
}

export function traceIdea(
  concept: string,
  fromYear: number | undefined,
  papers: CanonicalPaper[],
): TraceIdeaPayload {
  const scored = papers
    .filter((paper) => (fromYear ? (paper.year ?? 0) >= fromYear : true))
    .map((paper) => ({ paper, score: conceptRelevanceScore(concept, paper) }))
    .filter((item) => item.score >= 0.18);

  const filtered = scored
    .sort((a, b) => {
      if ((a.paper.year ?? 0) !== (b.paper.year ?? 0)) {
        return (a.paper.year ?? 0) - (b.paper.year ?? 0);
      }
      return b.score - a.score;
    })
    .map((item) => item.paper)
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

  const originCandidates = filtered.slice(0, 3);

  const byYear = new Map<number, CanonicalPaper[]>();
  for (const paper of filtered) {
    const year = paper.year ?? 0;
    if (!year) {
      continue;
    }
    const papersInYear = byYear.get(year) ?? [];
    papersInYear.push(paper);
    byYear.set(year, papersInYear);
  }

  const timeline = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, yearPapers]) => ({
      year,
      papers: yearPapers.slice(0, 5),
      note: `${yearPapers.length} relevant papers`,
    }));

  const branchingPapers = [...filtered]
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
    .slice(0, 5);

  return {
    concept,
    fromYear,
    originCandidates,
    timeline,
    branchingPapers,
  };
}
