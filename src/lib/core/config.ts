import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface AppConfig {
  version: string;
  debug: boolean;
  dbPath: string;
  disabledTools: string[];
  contactEmail?: string;
  semanticScholarApiKey?: string;
  semanticScholarBaseUrl?: string;
  unpaywallEmail?: string;
  unpaywallBaseUrl?: string;
  coreApiKey?: string;
  coreBaseUrl?: string;
  papersWithCodeBaseUrl?: string;
  huggingFaceBaseUrl?: string;
  openAlexBaseUrl?: string;
  arxivBaseUrl?: string;
  pubmedBaseUrl?: string;
  http: {
    host: string;
    port: number;
    bearerToken?: string;
    corsOrigin: string;
  };
}

function detectVersion(): string {
  const fallback = "0.1.0";
  try {
    const packageJsonPath = new URL("../../../package.json", import.meta.url);
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Ignore and use fallback.
  }
  return fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  return {
    version: detectVersion(),
    debug: parseBoolean(process.env.TROVE_DEBUG, false),
    dbPath: process.env.TROVE_DB_PATH ?? path.join(os.homedir(), ".trove-mcp", "trove.db"),
    disabledTools: parseCsv(process.env.TROVE_DISABLED_TOOLS),
    contactEmail: process.env.TROVE_CONTACT_EMAIL,
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
    semanticScholarBaseUrl: process.env.SEMANTIC_SCHOLAR_BASE_URL,
    unpaywallEmail: process.env.UNPAYWALL_EMAIL,
    unpaywallBaseUrl: process.env.UNPAYWALL_BASE_URL,
    coreApiKey: process.env.CORE_API_KEY,
    coreBaseUrl: process.env.CORE_BASE_URL,
    papersWithCodeBaseUrl: process.env.PAPERS_WITH_CODE_BASE_URL,
    huggingFaceBaseUrl: process.env.HUGGINGFACE_BASE_URL,
    openAlexBaseUrl: process.env.OPENALEX_BASE_URL,
    arxivBaseUrl: process.env.ARXIV_BASE_URL,
    pubmedBaseUrl: process.env.PUBMED_BASE_URL,
    http: {
      host: process.env.TROVE_HTTP_HOST ?? "127.0.0.1",
      port: parseNumber(process.env.TROVE_HTTP_PORT, 3000),
      bearerToken: process.env.TROVE_HTTP_BEARER_TOKEN,
      corsOrigin: process.env.TROVE_HTTP_CORS_ORIGIN ?? "*",
    },
  };
}
