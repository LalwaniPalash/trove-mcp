import { describe, expect, it } from "vitest";
import { canonicalPaperId, dedupePapers, paperAliasIds } from "../../src/lib/core/dedupe.js";

describe("dedupePapers", () => {
  it("deduplicates by DOI and keeps richer merged fields", () => {
    const papers = dedupePapers([
      {
        id: "1",
        title: "A Study",
        abstract: "Short abstract",
        year: 2020,
        doi: "10.1234/example",
        arxivId: undefined,
        pubmedId: undefined,
        s2Id: undefined,
        openAlexId: undefined,
        venue: "X",
        url: "https://example.com/1",
        pdfUrl: undefined,
        citationCount: 5,
        referenceCount: 2,
        authors: [{ name: "Alice" }],
        institutions: ["Inst A"],
        topics: ["topic-a"],
        fields: ["field-a"],
        openAccess: false,
        sourcePriority: ["openalex"],
      },
      {
        id: "2",
        title: "A Study (dup)",
        abstract:
          "This is a longer abstract that should be preferred when merging duplicate records by DOI.",
        year: 2020,
        doi: "10.1234/example",
        arxivId: undefined,
        pubmedId: undefined,
        s2Id: "s2-1",
        openAlexId: undefined,
        venue: "Y",
        url: "",
        pdfUrl: "https://example.com/paper.pdf",
        citationCount: 20,
        referenceCount: 5,
        authors: [{ name: "Alice" }, { name: "Bob" }],
        institutions: ["Inst B"],
        topics: ["topic-b"],
        fields: ["field-b"],
        openAccess: true,
        sourcePriority: ["semantic_scholar"],
      },
    ]);

    expect(papers).toHaveLength(1);
    expect(papers[0].id).toBe("doi:10.1234/example");
    expect(papers[0].citationCount).toBe(20);
    expect(papers[0].pdfUrl).toBe("https://example.com/paper.pdf");
    expect(papers[0].authors).toHaveLength(2);
    expect(papers[0].topics).toContain("topic-a");
    expect(papers[0].topics).toContain("topic-b");
  });

  it("collapses arxiv DOI aliases to a single arxiv canonical key", () => {
    const arxivPaper = {
      id: "arxiv:2302.07842",
      title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
      abstract: "We show chain-of-thought prompting improves reasoning.",
      year: 2022,
      doi: undefined,
      arxivId: "2302.07842",
      pubmedId: undefined,
      s2Id: undefined,
      openAlexId: undefined,
      venue: "arXiv",
      url: "https://arxiv.org/abs/2302.07842",
      pdfUrl: "https://arxiv.org/pdf/2302.07842.pdf",
      citationCount: 10,
      referenceCount: 10,
      authors: [{ name: "Wei" }],
      institutions: [],
      topics: [],
      fields: [],
      openAccess: true,
      sourcePriority: ["arxiv" as const],
    };
    const doiPaper = {
      ...arxivPaper,
      id: "doi:10.48550/arxiv.2302.07842",
      doi: "10.48550/arXiv.2302.07842",
      sourcePriority: ["openalex" as const],
    };

    expect(canonicalPaperId(arxivPaper)).toBe("arxiv:2302.07842");
    expect(canonicalPaperId(doiPaper)).toBe("arxiv:2302.07842");
    expect(paperAliasIds(doiPaper)).toContain("doi:10.48550/arxiv.2302.07842");

    const papers = dedupePapers([arxivPaper, doiPaper]);
    expect(papers).toHaveLength(1);
    expect(papers[0].id).toBe("arxiv:2302.07842");
  });
});
