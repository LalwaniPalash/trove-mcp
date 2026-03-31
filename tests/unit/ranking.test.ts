import { describe, expect, it } from "vitest";
import { rankPapers } from "../../src/lib/ranking/scorer.js";

describe("rankPapers", () => {
  it("filters off-topic papers when anchor terms are missing", () => {
    const ranked = rankPapers(
      "transformer language model",
      [
        {
          id: "a",
          title: "Transformer Language Model Improvements",
          abstract: "We show better results for transformer language models.",
          year: 2023,
          venue: "ACL",
          doi: "10.1/a",
          arxivId: undefined,
          pubmedId: undefined,
          s2Id: undefined,
          openAlexId: undefined,
          url: "",
          pdfUrl: "https://example.com/a.pdf",
          citationCount: 200,
          referenceCount: 30,
          authors: [{ name: "A" }],
          institutions: ["Inst A"],
          topics: ["NLP"],
          fields: ["computer science"],
          openAccess: true,
          sourcePriority: ["openalex"],
        },
        {
          id: "b",
          title: "Unrelated biology paper",
          abstract: "This paper studies proteins.",
          year: 2024,
          venue: "Bio",
          doi: "10.1/b",
          arxivId: undefined,
          pubmedId: undefined,
          s2Id: undefined,
          openAlexId: undefined,
          url: "",
          pdfUrl: undefined,
          citationCount: 5,
          referenceCount: 10,
          authors: [{ name: "B" }],
          institutions: ["Inst B"],
          topics: ["biology"],
          fields: ["biology"],
          openAccess: false,
          sourcePriority: ["openalex"],
        },
      ],
      { limit: 10 },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].paper.id).toBe("a");
  });
});
