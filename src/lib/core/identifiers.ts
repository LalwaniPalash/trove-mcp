export type IdentifierType =
  | "doi"
  | "arxiv"
  | "s2"
  | "openalex"
  | "pubmed"
  | "title";

export interface ParsedIdentifier {
  type: IdentifierType;
  value: string;
}

const DOI_PATTERN = /^10\.\d{4,9}\/.+/i;
const ARXIV_PATTERN = /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i;
const ARXIV_ABS_URL_PATTERN = /^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(v\d+)?)$/i;
const ARXIV_PDF_URL_PATTERN = /^https?:\/\/arxiv\.org\/pdf\/(\d{4}\.\d{4,5}(v\d+)?)(\.pdf)?$/i;
const OPENALEX_PATTERN = /^https?:\/\/openalex\.org\/[WAIFCS]\d+$/i;
const OPENALEX_SHORT_PATTERN = /^[WAIFCS]\d+$/i;
const PUBMED_PATTERN = /^pmid:\d+$/i;
const S2_PATTERN = /^s2:\w+$/i;
const DOI_ARXIV_PATTERN = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5}(v\d+)?)$/i;

function normalizeArxiv(value: string): string {
  return value.toLowerCase().replace(/^arxiv:/i, "").replace(/\.pdf$/i, "");
}

export function parseIdentifier(input: string): ParsedIdentifier {
  const trimmed = input.trim();
  const doiPrefixed = trimmed.replace(/^doi:/i, "");

  const doiAsArxiv = doiPrefixed.match(DOI_ARXIV_PATTERN);
  if (doiAsArxiv) {
    return { type: "arxiv", value: normalizeArxiv(doiAsArxiv[1]) };
  }

  const absUrlMatch = trimmed.match(ARXIV_ABS_URL_PATTERN);
  if (absUrlMatch) {
    return { type: "arxiv", value: normalizeArxiv(absUrlMatch[1]) };
  }

  const pdfUrlMatch = trimmed.match(ARXIV_PDF_URL_PATTERN);
  if (pdfUrlMatch) {
    return { type: "arxiv", value: normalizeArxiv(pdfUrlMatch[1]) };
  }

  if (DOI_PATTERN.test(doiPrefixed)) {
    return { type: "doi", value: doiPrefixed.toLowerCase() };
  }

  if (ARXIV_PATTERN.test(trimmed)) {
    return {
      type: "arxiv",
      value: normalizeArxiv(trimmed),
    };
  }

  if (OPENALEX_PATTERN.test(trimmed) || OPENALEX_SHORT_PATTERN.test(trimmed)) {
    const value = trimmed.toUpperCase().startsWith("HTTP")
      ? trimmed.split("/").at(-1) ?? trimmed
      : trimmed;
    return { type: "openalex", value };
  }

  if (PUBMED_PATTERN.test(trimmed)) {
    return { type: "pubmed", value: trimmed.replace(/^pmid:/i, "") };
  }

  if (S2_PATTERN.test(trimmed)) {
    return { type: "s2", value: trimmed.replace(/^s2:/i, "") };
  }

  return { type: "title", value: trimmed };
}
