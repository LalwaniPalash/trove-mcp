import type { AppConfig } from "../core/config.js";
import { TroveError } from "../core/errors.js";
import type { ProviderName } from "../types/common.js";
import type { HttpClient } from "../utils/http.js";

export interface UnpaywallLookup {
  doi: string;
  isOa: boolean;
  bestPdfUrl?: string;
  bestLandingUrl?: string;
}

export class UnpaywallAdapter {
  private readonly provider: ProviderName = "unpaywall";
  private readonly baseUrl: string;
  private readonly email?: string;

  constructor(
    private readonly httpClient: HttpClient,
    config: AppConfig,
  ) {
    this.baseUrl = config.unpaywallBaseUrl ?? "https://api.unpaywall.org/v2";
    this.email = config.unpaywallEmail ?? config.contactEmail;
  }

  isConfigured(): boolean {
    return Boolean(this.email);
  }

  async getByDoi(doi: string): Promise<UnpaywallLookup | null> {
    if (!this.email) {
      return null;
    }

    const normalized = doi.replace(/^https?:\/\/doi.org\//i, "");
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(normalized)}`);
    url.searchParams.set("email", this.email);

    let response;
    try {
      response = await this.httpClient.requestJson<Record<string, unknown>>(
        this.provider,
        url.toString(),
        {
          endpointLabel: "unpaywall:doi",
          license: "Unpaywall Data Feed Terms",
        },
      );
    } catch (error) {
      // Unpaywall answers 404 for DOIs it has no record of. That is a normal
      // "no open-access copy known", not a provider failure.
      if (error instanceof TroveError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }

    const best = (response.data.best_oa_location as Record<string, unknown> | undefined) ?? {};

    return {
      doi: normalized,
      isOa: Boolean(response.data.is_oa),
      bestPdfUrl: typeof best.url_for_pdf === "string" ? String(best.url_for_pdf) : undefined,
      bestLandingUrl: typeof best.url === "string" ? String(best.url) : undefined,
    };
  }
}
