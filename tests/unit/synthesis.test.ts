import { describe, expect, it } from "vitest";
import {
  buildLiteratureMap,
  comparePapers,
  conceptRelevanceScore,
  traceIdea,
} from "../../src/lib/synthesis/analysis.js";

const samplePapers = [
  {
    id: "p1",
    title: "Diffusion model scaling",
    abstract:
      "We show diffusion models improve image quality across multiple datasets and evaluation protocols. However, training cost is high and compute access remains a limitation.",
    year: 2021,
    venue: "CVPR",
    doi: "10.1/p1",
    arxivId: undefined,
    pubmedId: undefined,
    s2Id: undefined,
    openAlexId: undefined,
    url: "",
    pdfUrl: "",
    citationCount: 100,
    referenceCount: 20,
    authors: [{ name: "A" }],
    institutions: ["X"],
    topics: ["diffusion"],
    fields: ["computer science"],
    openAccess: true,
    sourcePriority: ["openalex" as const],
  },
  {
    id: "p2",
    title: "Diffusion with latent spaces",
    abstract:
      "Results demonstrate effective generation quality and improved efficiency over baseline samplers in repeated controlled experiments.",
    year: 2022,
    venue: "NeurIPS",
    doi: "10.1/p2",
    arxivId: undefined,
    pubmedId: undefined,
    s2Id: undefined,
    openAlexId: undefined,
    url: "",
    pdfUrl: "",
    citationCount: 80,
    referenceCount: 15,
    authors: [{ name: "B" }],
    institutions: ["Y"],
    topics: ["diffusion"],
    fields: ["computer science"],
    openAccess: true,
    sourcePriority: ["openalex" as const],
  },
  {
    id: "p3",
    title: "Aqueous solubility estimation for organic compounds",
    abstract: "We model solubility in chemistry using molecular descriptors.",
    year: 2019,
    venue: "Chem",
    doi: "10.1/p3",
    arxivId: undefined,
    pubmedId: undefined,
    s2Id: undefined,
    openAlexId: undefined,
    url: "",
    pdfUrl: "",
    citationCount: 55,
    referenceCount: 12,
    authors: [{ name: "C" }],
    institutions: ["Z"],
    topics: ["chemistry"],
    fields: ["chemistry"],
    openAccess: true,
    sourcePriority: ["openalex" as const],
  },
];

describe("synthesis analysis", () => {
  it("builds a literature map with claims", () => {
    const map = buildLiteratureMap("diffusion models", 2, samplePapers, {});
    expect(map.papers.length).toBeGreaterThan(0);
    expect(map.keyClaims.length).toBeGreaterThan(0);
    expect(map.influence[0].score).toBeGreaterThan(0);
    expect(map.keyClaims.every((claim) => !claim.claim.includes("..."))).toBe(true);
  });

  it("compares papers into structured output", () => {
    const comparison = comparePapers(samplePapers, {
      p1: {
        paperId: "p1",
        source: "arxiv",
        sourceUrl: "https://arxiv.org/pdf/1.pdf",
        availability: "full_text",
        truncation: { truncated: false, maxChunks: 20, returnedChunks: 2 },
        chunks: [
          {
            index: 0,
            heading: "Method",
            text: "We propose a diffusion framework and release code at https://github.com/example/diffusion.",
            tokenEstimate: 25,
          },
          {
            index: 1,
            heading: "Results",
            text: "Results show improvements over baselines on three datasets.",
            tokenEstimate: 15,
          },
        ],
      },
    });
    expect(comparison.papers).toHaveLength(3);
    expect(comparison.papers[0]).toHaveProperty("methodology");
    expect(comparison.papers[0]).toHaveProperty("findings");
    expect(comparison.papers[0]?.codeLinks.some((url) => url.includes("github.com"))).toBe(true);
  });

  it("rejects title/byline front matter from methodology extraction", () => {
    const paper = {
      ...samplePapers[0],
      id: "frontmatter-paper",
      title: "Training a Helpful and Harmless Assistant with Reinforcement Learning from Human Feedback",
    };

    const comparison = comparePapers([paper], {
      "frontmatter-paper": {
        paperId: "frontmatter-paper",
        source: "arxiv",
        sourceUrl: "https://arxiv.org/pdf/frontmatter.pdf",
        availability: "full_text",
        truncation: { truncated: false, maxChunks: 20, returnedChunks: 3 },
        chunks: [
          {
            index: 0,
            heading: "Method",
            text: "Training a Helpful and Harmless Assistant with Reinforcement Learning from Human Feedback Yuntao Bai Samuel et al.",
            tokenEstimate: 42,
          },
          {
            index: 1,
            heading: "Method",
            text: "We propose a two-stage RLHF training method with supervised warm-start and preference-model optimization.",
            tokenEstimate: 28,
          },
          {
            index: 2,
            heading: "Results",
            text: "Results show improved harmlessness compared with baseline policies.",
            tokenEstimate: 16,
          },
        ],
      },
    });

    const methodology = comparison.papers[0]?.methodology ?? [];
    expect(
      methodology.some((item) =>
        item.toLowerCase().startsWith(
          "training a helpful and harmless assistant with reinforcement learning from human feedback",
        ),
      ),
    ).toBe(false);
    expect(methodology.some((item) => item.toLowerCase().includes("we propose"))).toBe(true);
  });

  it("rejects title/byline front matter from literature map methods", () => {
    const paper = {
      ...samplePapers[0],
      id: "map-frontmatter-paper",
      title: "Training a Helpful and Harmless Assistant with Reinforcement Learning from Human Feedback",
    };

    const map = buildLiteratureMap("reinforcement learning from human feedback", 1, [paper], {
      "map-frontmatter-paper": {
        paperId: "map-frontmatter-paper",
        source: "arxiv",
        sourceUrl: "https://arxiv.org/pdf/frontmatter.pdf",
        availability: "full_text",
        truncation: { truncated: false, maxChunks: 20, returnedChunks: 2 },
        chunks: [
          {
            index: 0,
            heading: "Method",
            text: "Training a Helpful and Harmless Assistant with Reinforcement Learning from Human Feedback Yuntao Bai Samuel et al.",
            tokenEstimate: 42,
          },
          {
            index: 1,
            heading: "Method",
            text: "We propose a two-stage RLHF training method with supervised warm-start and preference-model optimization.",
            tokenEstimate: 28,
          },
        ],
      },
    });

    expect(
      map.methods.some((item) =>
        item.method
          .toLowerCase()
          .startsWith("training a helpful and harmless assistant with reinforcement learning from human feedback"),
      ),
    ).toBe(false);
    expect(map.methods.some((item) => item.method.toLowerCase().includes("we propose"))).toBe(true);
  });

  it("traces idea timeline", () => {
    const trace = traceIdea("diffusion", 2020, samplePapers);
    expect(trace.originCandidates.length).toBeGreaterThan(0);
    expect(trace.timeline.length).toBeGreaterThan(0);
  });

  it("concept relevance penalizes off-topic papers", () => {
    const relevantScore = conceptRelevanceScore("diffusion model", samplePapers[0]);
    const offTopicScore = conceptRelevanceScore("diffusion model", samplePapers[2]);
    expect(relevantScore).toBeGreaterThan(offTopicScore);
  });

  it("traceIdea filters off-topic noise", () => {
    const trace = traceIdea("transformer attention mechanism", 2015, [
      {
        ...samplePapers[0],
        id: "t1",
        title: "Transformer attention mechanism for language understanding",
        topics: ["transformer", "attention"],
        fields: ["computer science"],
      },
      samplePapers[2],
    ]);
    expect(trace.originCandidates.length).toBeGreaterThan(0);
    expect(trace.originCandidates.every((paper) => paper.fields.includes("computer science"))).toBe(true);
  });
});
