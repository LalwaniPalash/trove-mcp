export type ProviderName =
  | "openalex"
  | "semantic_scholar"
  | "arxiv"
  | "unpaywall"
  | "pubmed"
  | "paperswithcode"
  | "core"
  | "huggingface";

export type Status = "ok" | "partial" | "error";

export interface EnvelopeMeta {
  version: string;
}

export interface ProvenanceRecord {
  source: ProviderName;
  endpoint: string;
  timestamp: string;
  cached: boolean;
  license: string;
  latency_ms: number;
}

export interface Envelope<T> {
  status: Status;
  degraded: boolean;
  warnings: string[];
  provenance: ProvenanceRecord[];
  meta: EnvelopeMeta;
  data: T;
}

export interface ToolResultPayload<T> {
  envelope: Envelope<T>;
  asText: string;
}

export interface CanonicalPaper {
  id: string;
  title: string;
  abstract?: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  pubmedId?: string;
  s2Id?: string;
  openAlexId?: string;
  url?: string;
  pdfUrl?: string;
  citationCount?: number;
  referenceCount?: number;
  authors: CanonicalAuthorRef[];
  institutions: string[];
  topics: string[];
  fields: string[];
  openAccess: boolean;
  sourcePriority: ProviderName[];
}

export interface CanonicalAuthorRef {
  id?: string;
  name: string;
  institution?: string;
}

export interface CanonicalAuthor {
  id: string;
  name: string;
  aliases: string[];
  affiliation?: string;
  hIndex?: number;
  citationCount?: number;
  paperCount?: number;
  mostCitedPaperIds: string[];
  recentPaperIds: string[];
}

export interface CanonicalInstitution {
  id: string;
  name: string;
  country?: string;
  paperCount?: number;
  citationCount?: number;
}

export interface SearchFilters {
  year_min?: number;
  year_max?: number;
  field?: string;
  topic?: string;
  open_access_only?: boolean;
  citation_min?: number;
  institution?: string;
  author?: string;
  limit?: number;
}

export interface FullTextChunk {
  index: number;
  heading?: string;
  text: string;
  tokenEstimate: number;
}

export type FullTextAvailability =
  | "full_text"
  | "partial_text"
  | "abstract_only"
  | "unavailable";

export interface FullTextPayload {
  paperId: string;
  source: ProviderName | "none";
  sourceUrl?: string;
  availability: FullTextAvailability;
  truncation: {
    truncated: boolean;
    maxChunks: number;
    returnedChunks: number;
  };
  chunks: FullTextChunk[];
}

export interface SearchResult {
  paper: CanonicalPaper;
  score: number;
  reasons: string[];
}

export interface CitationEdge {
  sourcePaperId: string;
  targetPaperId: string;
  influenceScore?: number;
  year?: number;
}

export interface LiteratureClaim {
  paperId: string;
  claim: string;
  confidence: number;
  evidence: "abstract" | "full_text";
}

export interface LiteratureMap {
  query: string;
  depth: number;
  papers: CanonicalPaper[];
  keyClaims: LiteratureClaim[];
  methods: Array<{ paperId: string; method: string }>;
  limitations: Array<{ paperId: string; limitation: string }>;
  consensus: string[];
  contradictions: string[];
  influence: Array<{ paperId: string; score: number }>;
}

export interface ComparePapersPayload {
  papers: Array<{
    paper: CanonicalPaper;
    methodology: string[];
    findings: string[];
    limitations: string[];
    reproducibilitySignals: string[];
    codeLinks: string[];
  }>;
}

export interface TraceIdeaPayload {
  concept: string;
  fromYear?: number;
  originCandidates: CanonicalPaper[];
  timeline: Array<{
    year: number;
    papers: CanonicalPaper[];
    note: string;
  }>;
  branchingPapers: CanonicalPaper[];
}
