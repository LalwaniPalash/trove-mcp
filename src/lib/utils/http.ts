import { TroveError, toErrorMessage } from "../core/errors.js";
import { nowIso } from "./time.js";
import type { ProviderName, ProvenanceRecord } from "../types/common.js";

interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  endpointLabel?: string;
  license?: string;
}

interface HttpResponse<T> {
  data: T;
  provenance: ProvenanceRecord;
}

const DEFAULT_MIN_INTERVAL_MS: Record<ProviderName, number> = {
  openalex: 200,
  semantic_scholar: 200,
  arxiv: 350,
  unpaywall: 250,
  pubmed: 250,
  paperswithcode: 250,
  core: 300,
  huggingface: 250,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000));
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const coreRetryAt = headers.get("x-ratelimit-retry-after");
  if (coreRetryAt) {
    const ts = Date.parse(coreRetryAt);
    if (Number.isFinite(ts)) {
      return Math.max(0, ts - Date.now());
    }
  }

  return undefined;
}

export class RateLimiter {
  private readonly lastByProvider = new Map<ProviderName, number>();

  async throttle(provider: ProviderName): Promise<void> {
    const now = Date.now();
    const minInterval = DEFAULT_MIN_INTERVAL_MS[provider] ?? 250;
    const last = this.lastByProvider.get(provider) ?? 0;
    const waitFor = Math.max(0, minInterval - (now - last));
    if (waitFor > 0) {
      await sleep(waitFor);
    }
    this.lastByProvider.set(provider, Date.now());
  }
}

export class HttpClient {
  constructor(private readonly limiter: RateLimiter) {}

  async requestJson<T>(
    provider: ProviderName,
    url: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const retries = options.retries ?? 2;

    let lastError: unknown;

    const originalHost = new URL(url).host;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.limiter.throttle(provider);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(options.headers ?? {}),
          },
          body: options.body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.status >= 500) {
          throw new TroveError(
            `Upstream ${provider} server error (${response.status})`,
            "UPSTREAM_5XX",
            true,
            response.status,
          );
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const retryAfterMs = parseRetryAfterMs(response.headers);
          throw new TroveError(
            `Upstream ${provider} error (${response.status}) ${errorBody.slice(0, 180)}`,
            "UPSTREAM_NON_OK",
            response.status === 429,
            response.status,
            retryAfterMs,
          );
        }

        if (response.redirected) {
          const redirectedHost = new URL(response.url).host;
          if (redirectedHost !== originalHost) {
            throw new TroveError(
              `Upstream ${provider} redirected from ${originalHost} to ${redirectedHost} (${response.url})`,
              "UPSTREAM_REDIRECT",
              false,
            );
          }
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("json")) {
          const preview = (await response.text().catch(() => "")).slice(0, 180);
          throw new TroveError(
            `Upstream ${provider} returned non-JSON content-type (${contentType}). Preview: ${preview}`,
            "UPSTREAM_NON_JSON",
            false,
          );
        }

        const data = (await response.json()) as T;

        return {
          data,
          provenance: {
            source: provider,
            endpoint: options.endpointLabel ?? url,
            timestamp: nowIso(),
            cached: false,
            license: options.license ?? "unknown",
            latency_ms: Date.now() - startedAt,
          },
        };
      } catch (error) {
        lastError = error;
        if (error instanceof TroveError && !error.retryable) {
          break;
        }
        if (attempt === retries) {
          break;
        }
        const retryDelay = error instanceof TroveError && error.retryAfterMs !== undefined
          ? Math.min(Math.max(error.retryAfterMs, 250), 10_000)
          : 250 * (attempt + 1);
        await sleep(retryDelay);
      }
    }

    if (lastError instanceof TroveError) {
      throw lastError;
    }
    throw new TroveError(
      `Request failed for ${provider}: ${toErrorMessage(lastError)}`,
      "HTTP_FAILED",
      true,
    );
  }

  async requestText(
    provider: ProviderName,
    url: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<string>> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 25_000;
    const retries = options.retries ?? 2;

    let lastError: unknown;

    const originalHost = new URL(url).host;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.limiter.throttle(provider);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: options.headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers);
          throw new TroveError(
            `Upstream ${provider} text endpoint error (${response.status})`,
            "UPSTREAM_NON_OK",
            response.status === 429,
            response.status,
            retryAfterMs,
          );
        }

        if (response.redirected) {
          const redirectedHost = new URL(response.url).host;
          if (redirectedHost !== originalHost) {
            throw new TroveError(
              `Upstream ${provider} redirected from ${originalHost} to ${redirectedHost} (${response.url})`,
              "UPSTREAM_REDIRECT",
              false,
            );
          }
        }

        const data = await response.text();
        return {
          data,
          provenance: {
            source: provider,
            endpoint: options.endpointLabel ?? url,
            timestamp: nowIso(),
            cached: false,
            license: options.license ?? "unknown",
            latency_ms: Date.now() - startedAt,
          },
        };
      } catch (error) {
        lastError = error;
        if (error instanceof TroveError && !error.retryable) {
          break;
        }
        if (attempt === retries) {
          break;
        }
        const retryDelay = error instanceof TroveError && error.retryAfterMs !== undefined
          ? Math.min(Math.max(error.retryAfterMs, 300), 10_000)
          : 300 * (attempt + 1);
        await sleep(retryDelay);
      }
    }

    if (lastError instanceof TroveError) {
      throw lastError;
    }

    throw new TroveError(
      `Text request failed for ${provider}: ${toErrorMessage(lastError)}`,
      "HTTP_TEXT_FAILED",
      true,
    );
  }
}
