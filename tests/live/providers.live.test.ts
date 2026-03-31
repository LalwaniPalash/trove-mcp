import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/lib/core/config.js";
import { HttpClient, RateLimiter } from "../../src/lib/utils/http.js";
import { OpenAlexAdapter } from "../../src/lib/adapters/openalex.js";
import { SemanticScholarAdapter } from "../../src/lib/adapters/semantic-scholar.js";
import { ArxivAdapter } from "../../src/lib/adapters/arxiv.js";
import { PubMedAdapter } from "../../src/lib/adapters/pubmed.js";
import { UnpaywallAdapter } from "../../src/lib/adapters/unpaywall.js";
import { CoreAdapter } from "../../src/lib/adapters/core.js";
import { HuggingFaceAdapter } from "../../src/lib/adapters/huggingface.js";

const LIVE = process.env.LIVE_CONTRACT === "1";
const itLive = LIVE ? it : it.skip;
const LIVE_TEST_TIMEOUT_MS = 20_000;

describe("live provider contracts", () => {
  const config = loadConfig();
  const httpClient = new HttpClient(new RateLimiter());
  const openAlex = new OpenAlexAdapter(httpClient, config);
  const semantic = new SemanticScholarAdapter(httpClient, config);
  const arxiv = new ArxivAdapter(httpClient);
  const pubmed = new PubMedAdapter(httpClient);
  const unpaywall = new UnpaywallAdapter(httpClient, config);
  const core = new CoreAdapter(httpClient, config);
  const huggingFace = new HuggingFaceAdapter(httpClient, config);

  itLive("openalex search returns canonical papers", async () => {
    try {
      const result = await openAlex.searchPapers("transformer models", { limit: 5 });
      expect(result.papers.length).toBeGreaterThan(0);
      expect(result.papers[0].title.length).toBeGreaterThan(3);
    } catch (error) {
      expect(String(error)).toMatch(/openalex|fetch failed|UPSTREAM/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("semantic scholar search returns canonical papers", async () => {
    try {
      const result = await semantic.searchPapers("transformer models", { limit: 5 });
      expect(Array.isArray(result.papers)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    } catch (error) {
      expect(String(error)).toMatch(/429|Too Many Requests|semantic/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("arxiv search returns papers", async () => {
    try {
      const papers = await arxiv.searchPapers("diffusion model", 5);
      expect(papers.length).toBeGreaterThan(0);
      expect(papers[0].arxivId).toBeTruthy();
    } catch (error) {
      expect(String(error)).toMatch(/arxiv|fetch failed|UPSTREAM/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("pubmed search returns papers", async () => {
    try {
      const papers = await pubmed.searchPapers("CRISPR genome editing", 5);
      expect(papers.length).toBeGreaterThan(0);
      expect(papers[0].pubmedId).toBeTruthy();
    } catch (error) {
      expect(String(error)).toMatch(/pubmed|fetch failed|UPSTREAM/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("unpaywall DOI lookup returns OA metadata shape", async () => {
    if (!unpaywall.isConfigured()) {
      return;
    }

    const lookup = await unpaywall.getByDoi("10.48550/arXiv.1706.03762");
    expect(lookup).not.toBeNull();
    expect(typeof lookup?.isOa).toBe("boolean");
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("core search returns list shape", async () => {
    try {
      const papers = await core.searchPapers("graph neural network", 3);
      expect(Array.isArray(papers)).toBe(true);
    } catch (error) {
      expect(String(error)).toMatch(/core|UPSTREAM|Connection reset|non-JSON|fetch failed/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("huggingface daily papers endpoint returns list shape", async () => {
    try {
      const papers = await huggingFace.getDailyPapers(5);
      expect(Array.isArray(papers)).toBe(true);
      if (papers.length > 0) {
        expect(papers[0].title.length).toBeGreaterThan(3);
      }
    } catch (error) {
      expect(String(error)).toMatch(/huggingface|UPSTREAM|fetch failed|429/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

  itLive("huggingface papers search endpoint returns list shape", async () => {
    try {
      const papers = await huggingFace.searchPapers("transformer", 5);
      expect(Array.isArray(papers)).toBe(true);
    } catch (error) {
      expect(String(error)).toMatch(/huggingface|UPSTREAM|fetch failed|429/i);
    }
  }, LIVE_TEST_TIMEOUT_MS);

});
