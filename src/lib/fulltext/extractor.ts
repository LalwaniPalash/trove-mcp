import { createRequire } from "node:module";
import pdfParse from "pdf-parse";
import type { FullTextChunk, FullTextPayload, ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

interface ExtractResult {
  source: ProviderName;
  sourceUrl: string;
  rawText: string;
}

export interface FullTextOptions {
  maxChunks?: number;
  maxChunkChars?: number;
}

interface ChunkBuildResult {
  chunks: FullTextChunk[];
  qualityScore: number;
}

const require = createRequire(import.meta.url);
const PDF_PARSE_VERSION = "v1.10.100";
let pdfWarningsSuppressed = false;

function toStderrLine(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

type ConsoleMethod = (...args: unknown[]) => void;
type ConsoleMethodName = "log" | "info" | "warn";
type StdoutWrite = typeof process.stdout.write;

const forwardedToStderr: ConsoleMethod = (...args: unknown[]) => {
  process.stderr.write(`${toStderrLine(args)}\n`);
};

const interceptedMethods: ConsoleMethodName[] = ["log", "info", "warn"];
let stdoutGuardDepth = 0;
let originalConsoleMethods: Partial<Record<ConsoleMethodName, ConsoleMethod>> | null = null;
let originalStdoutWrite: StdoutWrite | null = null;
let pdfParseGuardQueue: Promise<void> = Promise.resolve();

const forwardedStdoutWrite: StdoutWrite = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
  let cb: ((error?: Error | null) => void) | undefined;
  let content = "";

  if (typeof encoding === "function") {
    cb = encoding;
  } else {
    cb = callback;
  }

  if (typeof chunk === "string") {
    content = chunk;
  } else if (Buffer.isBuffer(chunk)) {
    content = chunk.toString(typeof encoding === "string" ? encoding : "utf8");
  } else if (chunk != null) {
    content = String(chunk);
  }

  if (content.length > 0) {
    process.stderr.write(content);
  }

  if (cb) {
    cb(null);
  }
  return true;
}) as StdoutWrite;

function beginStdoutGuard(): void {
  if (stdoutGuardDepth === 0) {
    originalConsoleMethods = {
      log: console.log,
      info: console.info,
      warn: console.warn,
    };
    for (const method of interceptedMethods) {
      console[method] = forwardedToStderr;
    }
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = forwardedStdoutWrite;
  }
  stdoutGuardDepth += 1;
}

function endStdoutGuard(): void {
  if (stdoutGuardDepth <= 0) {
    return;
  }

  stdoutGuardDepth -= 1;
  if (stdoutGuardDepth === 0 && originalConsoleMethods) {
    for (const method of interceptedMethods) {
      const original = originalConsoleMethods[method];
      if (original) {
        console[method] = original;
      }
    }
    if (originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
      originalStdoutWrite = null;
    }
    originalConsoleMethods = null;
  }
}

async function parsePdfWithStdoutGuard(buffer: Buffer): Promise<Awaited<ReturnType<typeof pdfParse>>> {
  const prior = pdfParseGuardQueue;
  let releaseQueue: () => void = () => {};
  pdfParseGuardQueue = new Promise<void>((resolve) => {
    releaseQueue = () => resolve();
  });

  await prior;
  beginStdoutGuard();
  try {
    return await pdfParse(buffer, { version: PDF_PARSE_VERSION });
  } finally {
    endStdoutGuard();
    releaseQueue();
  }
}

function suppressPdfWarnings(): void {
  if (pdfWarningsSuppressed) {
    return;
  }

  const modulePaths = [
    `pdf-parse/lib/pdf.js/${PDF_PARSE_VERSION}/build/pdf.js`,
    `pdf-parse/lib/pdf.js/${PDF_PARSE_VERSION}/build/pdf.worker.js`,
  ];

  for (const modulePath of modulePaths) {
    try {
      const pdfModule = require(modulePath);
      if (pdfModule && typeof pdfModule === "object" && "verbosity" in pdfModule) {
        (pdfModule as { verbosity: number }).verbosity = 0;
      }
    } catch {
      // Ignore and rely on stdout/stderr interception as a fallback.
    }
  }

  pdfWarningsSuppressed = true;
}

export function cleanText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isLikelyNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  if (trimmed.length <= 2) {
    return true;
  }

  if (/^[\p{P}\p{S}\d\s]+$/u.test(trimmed)) {
    return true;
  }

  if (/\b\S+@\S+\.\S+\b/.test(trimmed)) {
    return true;
  }

  if (/^\s*[\.\d]+\s+[A-Za-z].*\.{2,}\s*\d+\s*$/.test(trimmed)) {
    return true;
  }

  if (/^\d+(\.\d+){1,}\s+[A-Za-z].*\.{1,}\s*\d+\s*$/.test(trimmed)) {
    return true;
  }

  if (/^(arXiv|DOI|©|Copyright)\b/i.test(trimmed)) {
    return true;
  }

  return false;
}

function isSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4 || trimmed.length > 80) {
    return false;
  }

  if (/^\d+(\.\d+)*\s+[A-Z][A-Za-z0-9\-:,() ]+$/.test(trimmed)) {
    return true;
  }

  if (/^[A-Z][A-Z0-9\-:,() ]+$/.test(trimmed) && trimmed.split(" ").length <= 8) {
    return true;
  }

  return false;
}

function normalizePdfText(rawText: string): string {
  const lines = rawText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  const paragraphs: string[] = [];
  let current: string[] = [];

  const flushCurrent = () => {
    if (!current.length) {
      return;
    }
    const paragraph = current.join(" ").replace(/\s+/g, " ").trim();
    if (paragraph.length >= 40) {
      paragraphs.push(paragraph);
    }
    current = [];
  };

  for (const line of lines) {
    if (!line) {
      flushCurrent();
      continue;
    }

    if (isLikelyNoiseLine(line)) {
      continue;
    }

    if (isSectionHeading(line)) {
      flushCurrent();
      paragraphs.push(`## ${line}`);
      continue;
    }

    current.push(line);
  }
  flushCurrent();

  return paragraphs.join("\n\n").trim();
}

function scoreChunkQuality(chunks: FullTextChunk[]): number {
  if (chunks.length === 0) {
    return 0;
  }

  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const longChunks = chunks.filter((chunk) => chunk.text.length >= 200).length;
  const sentenceLike = chunks.filter((chunk) => /[.!?]/.test(chunk.text)).length;
  const avgLen = totalChars / chunks.length;

  let score = 0;
  score += Math.min(1, avgLen / 400) * 0.4;
  score += Math.min(1, longChunks / Math.max(2, chunks.length)) * 0.3;
  score += Math.min(1, sentenceLike / chunks.length) * 0.3;
  return Number(score.toFixed(4));
}

function toChunks(text: string, options: FullTextOptions): ChunkBuildResult {
  const maxChunkChars = options.maxChunkChars ?? 1800;
  const maxChunks = options.maxChunks ?? 20;

  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40);
  const chunks: FullTextChunk[] = [];
  let current = "";
  let idx = 0;
  let currentHeading: string | undefined;

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith("## ")) {
      if (current) {
        chunks.push({
          index: idx,
          heading: currentHeading,
          text: current,
          tokenEstimate: Math.ceil(current.length / 4),
        });
        idx += 1;
        if (chunks.length >= maxChunks) {
          break;
        }
      }
      current = "";
      currentHeading = paragraph.replace(/^##\s*/, "").trim();
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push({
        index: idx,
        heading: currentHeading,
        text: current,
        tokenEstimate: Math.ceil(current.length / 4),
      });
      idx += 1;
      if (chunks.length >= maxChunks) {
        break;
      }
    }

    if (paragraph.length > maxChunkChars) {
      const slices = paragraph.match(new RegExp(`.{1,${maxChunkChars}}`, "g")) ?? [paragraph];
      for (const slice of slices) {
        chunks.push({
          index: idx,
          heading: currentHeading,
          text: slice,
          tokenEstimate: Math.ceil(slice.length / 4),
        });
        idx += 1;
        if (chunks.length >= maxChunks) {
          break;
        }
      }
      current = "";
      if (chunks.length >= maxChunks) {
        break;
      }
    } else {
      current = paragraph;
    }
  }

  if (current && chunks.length < maxChunks) {
    chunks.push({
      index: idx,
      heading: currentHeading,
      text: current,
      tokenEstimate: Math.ceil(current.length / 4),
    });
  }

  return { chunks, qualityScore: scoreChunkQuality(chunks) };
}

const PDF_IDLE_TIMEOUT_MS = 15_000;
const PDF_TOTAL_TIMEOUT_MS = 60_000;
const PDF_MAX_BYTES = 30 * 1024 * 1024;

export function isPdf(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 1024).includes("%PDF-");
}

// Journal landing pages name their PDF in a Highwire `citation_pdf_url` meta tag
// (Google Scholar requires it), so an HTML "PDF link" is often one hop away.
export function citationPdfUrl(html: string, baseUrl: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/name\s*=\s*["']citation_pdf_url["']/i.test(tag)) {
      continue;
    }
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!content) {
      continue;
    }
    try {
      const url = new URL(content.replace(/&amp;/g, "&"), baseUrl);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface FetchedDocument {
  buffer: Buffer;
  finalUrl: string;
}

async function fetchDocument(url: string): Promise<FetchedDocument | null> {
  // Abort when the host goes quiet, not when a slow but live download passes a
  // fixed mark: some repositories stream a 1 MB PDF over 20-30 s. The overall
  // cap still stops one host from stalling every caller.
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(), PDF_TOTAL_TIMEOUT_MS);
  let idle = setTimeout(() => controller.abort(), PDF_IDLE_TIMEOUT_MS);
  const stillAlive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), PDF_IDLE_TIMEOUT_MS);
  };

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "trove-mcp (+https://github.com/LalwaniPalash/trove-mcp)", Accept: "application/pdf" },
    });
    if (!response.ok || !response.body) {
      return null;
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > PDF_MAX_BYTES) {
      return null;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      stillAlive();
      size += value.byteLength;
      // content-length can be absent or wrong; enforce the cap on what arrives.
      if (size > PDF_MAX_BYTES) {
        controller.abort();
        return null;
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks), finalUrl: response.url || url };
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
  }
}

export async function extractPdfText(
  httpClient: HttpClient,
  source: ProviderName,
  url: string,
): Promise<ExtractResult | null> {
  try {
    suppressPdfWarnings();
    let document = await fetchDocument(url);
    if (!document) {
      return null;
    }
    // A landing page is not a PDF. Follow its declared PDF link once; never
    // hand HTML to the parser.
    if (!isPdf(document.buffer)) {
      const pdfUrl = citationPdfUrl(document.buffer.subarray(0, 512 * 1024).toString("utf8"), document.finalUrl);
      document = pdfUrl ? await fetchDocument(pdfUrl) : null;
      if (!document || !isPdf(document.buffer)) {
        return null;
      }
    }

    // pdf.js (used under pdf-parse) can emit warnings on console methods.
    // In MCP stdio mode stdout must be JSON-only, so redirect while parsing.
    // Parsing is serialized to avoid concurrent guard restore races.
    const parsed = await parsePdfWithStdoutGuard(document.buffer);

    return {
      source,
      sourceUrl: document.finalUrl,
      rawText: normalizePdfText(cleanText(parsed.text ?? "")),
    };
  } catch {
    return null;
  }
}

export function toFullTextPayload(
  paperId: string,
  extraction: ExtractResult | null,
  fallbackAbstract: string | undefined,
  options: FullTextOptions = {},
): FullTextPayload {
  if (!extraction?.rawText) {
    if (fallbackAbstract) {
      return {
        paperId,
        source: "none",
        availability: "abstract_only",
        truncation: {
          truncated: false,
          maxChunks: 1,
          returnedChunks: 1,
        },
        chunks: [
          {
            index: 0,
            heading: "Abstract",
            text: fallbackAbstract,
            tokenEstimate: Math.ceil(fallbackAbstract.length / 4),
          },
        ],
      };
    }

    return {
      paperId,
      source: "none",
      availability: "unavailable",
      truncation: {
        truncated: false,
        maxChunks: options.maxChunks ?? 20,
        returnedChunks: 0,
      },
      chunks: [],
    };
  }

  const { chunks, qualityScore } = toChunks(extraction.rawText, options);
  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const lowQuality = qualityScore < 0.34 || totalChars < 900 || (chunks.length < 2 && totalChars < 1000);

  if (lowQuality && fallbackAbstract) {
    return {
      paperId,
      source: "none",
      availability: "abstract_only",
      truncation: {
        truncated: false,
        maxChunks: 1,
        returnedChunks: 1,
      },
      chunks: [
        {
          index: 0,
          heading: "Abstract",
          text: fallbackAbstract,
          tokenEstimate: Math.ceil(fallbackAbstract.length / 4),
        },
      ],
    };
  }

  if (lowQuality) {
    return {
      paperId,
      source: "none",
      availability: "unavailable",
      truncation: {
        truncated: false,
        maxChunks: options.maxChunks ?? 20,
        returnedChunks: 0,
      },
      chunks: [],
    };
  }

  return {
    paperId,
    source: extraction.source,
    sourceUrl: extraction.sourceUrl,
    availability: chunks.length > 0 ? "full_text" : "partial_text",
    truncation: {
      truncated: chunks.length >= (options.maxChunks ?? 20),
      maxChunks: options.maxChunks ?? 20,
      returnedChunks: chunks.length,
    },
    chunks,
  };
}
