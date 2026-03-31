import type { AppConfig } from "./config.js";
import { Logger } from "./logger.js";
import { setDefaultEnvelopeMeta } from "./envelope.js";
import { TroveRepository } from "../db/repository.js";
import { HttpClient, RateLimiter } from "../utils/http.js";
import { OpenAlexAdapter } from "../adapters/openalex.js";
import { SemanticScholarAdapter } from "../adapters/semantic-scholar.js";
import { ArxivAdapter } from "../adapters/arxiv.js";
import { UnpaywallAdapter } from "../adapters/unpaywall.js";
import { PubMedAdapter } from "../adapters/pubmed.js";
import { CoreAdapter } from "../adapters/core.js";
import { HuggingFaceAdapter } from "../adapters/huggingface.js";
import { ResearchService } from "./research-service.js";

export interface AppContext {
  logger: Logger;
  repo: TroveRepository;
  service: ResearchService;
}

export function createContext(config: AppConfig): AppContext {
  setDefaultEnvelopeMeta({ version: config.version });
  const logger = new Logger(config);
  const repo = new TroveRepository(config.dbPath);
  const httpClient = new HttpClient(new RateLimiter());

  const openAlex = new OpenAlexAdapter(httpClient, config);
  const semantic = new SemanticScholarAdapter(httpClient, config);
  const arxiv = new ArxivAdapter(httpClient, config);
  const unpaywall = new UnpaywallAdapter(httpClient, config);
  const pubmed = new PubMedAdapter(httpClient, config);
  const core = new CoreAdapter(httpClient, config);
  const huggingFace = new HuggingFaceAdapter(httpClient, config);

  const service = new ResearchService(
    repo,
    logger,
    httpClient,
    config.version,
    openAlex,
    semantic,
    arxiv,
    unpaywall,
    pubmed,
    core,
    huggingFace,
  );

  return {
    logger,
    repo,
    service,
  };
}
