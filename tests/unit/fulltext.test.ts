import { describe, expect, it } from "vitest";
import { toFullTextPayload } from "../../src/lib/fulltext/extractor.js";

describe("toFullTextPayload", () => {
  it("falls back to abstract-only when extraction is missing", () => {
    const payload = toFullTextPayload("doi:10.1/example", null, "Abstract only text.");
    expect(payload.availability).toBe("abstract_only");
    expect(payload.chunks).toHaveLength(1);
    expect(payload.chunks[0].heading).toBe("Abstract");
  });

  it("marks unavailable when no extraction and no abstract", () => {
    const payload = toFullTextPayload("doi:10.1/example", null, undefined);
    expect(payload.availability).toBe("unavailable");
    expect(payload.chunks).toHaveLength(0);
  });

  it("downgrades low-quality fragmented extraction to abstract-only", () => {
    const payload = toFullTextPayload(
      "doi:10.1/example",
      {
        source: "arxiv",
        sourceUrl: "https://arxiv.org/pdf/1234.56789.pdf",
        rawText: "A\nB\nC\n*\nJohn Doe\njohn@example.com\n1.2 Intro ..... 13",
      },
      "This is a reliable abstract with complete sentences for fallback.",
    );
    expect(payload.availability).toBe("abstract_only");
    expect(payload.source).toBe("none");
    expect(payload.chunks[0]?.heading).toBe("Abstract");
  });

  it("returns semantic paragraph-level full_text when extraction quality is sufficient", () => {
    const text = [
      "## Introduction",
      "",
      "We present a method that improves quality across multiple benchmarks with strong empirical gains. The model uses a stable training pipeline and controlled ablations to verify the impact of each major component under consistent evaluation settings. We also include a broad robustness section that reports behavior under multiple perturbation families and shifts in distribution.",
      "",
      "## Method",
      "",
      "Our architecture combines attention with retrieval and a calibrated objective. We evaluate on three datasets and report clear improvements over baselines, while documenting implementation details, hyperparameters, and runtime budgets to ensure practical reproducibility. Additional experiments compare learned representations against classical and modern alternatives.",
      "",
      "## Limitations",
      "",
      "However, the method requires substantial compute and we leave broader multilingual evaluation for future work. We also observe reduced gains on low-resource tasks and note that broader fairness analysis is needed before deployment in sensitive domains.",
    ].join("\n\n");

    const payload = toFullTextPayload(
      "doi:10.1/example",
      {
        source: "arxiv",
        sourceUrl: "https://arxiv.org/pdf/1234.56789.pdf",
        rawText: text,
      },
      undefined,
    );

    expect(payload.availability).toBe("full_text");
    expect(payload.chunks.length).toBeGreaterThanOrEqual(1);
    expect(payload.chunks.every((chunk) => chunk.text.length >= 40)).toBe(true);
  });
});
