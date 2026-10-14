import { describe, expect, it, vi } from "vitest";
import { CoreAdapter } from "../../src/lib/adapters/core.js";
import { openAlexPdfUrl } from "../../src/lib/adapters/openalex.js";
import { isPdf } from "../../src/lib/fulltext/extractor.js";
import { extractClaims } from "../../src/lib/synthesis/analysis.js";
import type { AppConfig } from "../../src/lib/core/config.js";
import type { CanonicalPaper } from "../../src/lib/types/common.js";
import type { HttpClient } from "../../src/lib/utils/http.js";

function coreWith(results: Array<Record<string, unknown>>) {
  const requestJson = vi.fn(async () => ({ data: { results } }));
  const adapter = new CoreAdapter({ requestJson } as unknown as HttpClient, {} as AppConfig);
  return { adapter, requestJson };
}

describe("CORE full-text lookup", () => {
  it("sends a quoted DOI field query", async () => {
    const { adapter, requestJson } = coreWith([]);
    await adapter.findPdfByDoi("10.1/ABC");
    const url = new URL(requestJson.mock.calls[0][1] as string);
    expect(url.searchParams.get("q")).toBe('doi:"10.1/abc"');
  });

  it("never returns a PDF belonging to a different DOI", async () => {
    const { adapter } = coreWith([{ doi: "10.9/other", downloadUrl: "https://core.ac.uk/other.pdf" }]);
    await expect(adapter.findPdfByDoi("10.1/abc")).resolves.toBeNull();
  });

  it("returns the PDF for an exact DOI match", async () => {
    const { adapter } = coreWith([{ doi: "10.1/ABC", downloadUrl: "https://core.ac.uk/abc.pdf" }]);
    await expect(adapter.findPdfByDoi("10.1/abc")).resolves.toBe("https://core.ac.uk/abc.pdf");
  });
});

describe("OpenAlex PDF location", () => {
  it("ignores landing pages and uses an open-access location's pdf_url", () => {
    const work = {
      open_access: { oa_url: "https://doi.org/10.1/abc" },
      best_oa_location: { is_oa: true, pdf_url: null },
      locations: [
        { is_oa: false, pdf_url: "https://paywalled.example/abc.pdf" },
        { is_oa: true, pdf_url: "https://repository.example/abc.pdf" },
      ],
    };
    expect(openAlexPdfUrl(work)).toBe("https://repository.example/abc.pdf");
  });

  it("returns undefined when no open-access location has a PDF", () => {
    expect(openAlexPdfUrl({ best_oa_location: { is_oa: true, pdf_url: null }, locations: [] })).toBeUndefined();
  });
});

describe("PDF detection", () => {
  it("accepts a PDF header and rejects an HTML page", () => {
    expect(isPdf(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(isPdf(Buffer.from("<!doctype html><html>landing page</html>"))).toBe(false);
  });
});

describe("claim extraction outside the sciences", () => {
  it("recognises argument-style findings in legal scholarship", () => {
    const paper = {
      id: "doi:10.1/law",
      title: "Transboundary harm",
      abstract:
        "This article argues that the no-harm rule now operates as a procedural duty of due diligence rather than a strict obligation of result.",
      authors: [],
      institutions: [],
      topics: [],
      fields: [],
      sourcePriority: ["openalex"],
    } as unknown as CanonicalPaper;
    expect(extractClaims(paper).map((c) => c.claim)).toHaveLength(1);
  });
});

describe("arXiv ID detection", () => {
  it("does not read arXiv IDs out of ordinary DOIs", async () => {
    const { extractArxivIdFromText } = await import("../../src/lib/core/research-service.js");
    expect(extractArxivIdFromText("10.12957/rqi.2019.31294")).toBeNull();
    expect(extractArxivIdFromText("10.1016/j.example.2104.10234")).toBeNull();
  });

  it("still recognises real arXiv identifiers", async () => {
    const { extractArxivIdFromText } = await import("../../src/lib/core/research-service.js");
    expect(extractArxivIdFromText("10.48550/arXiv.1706.03762")).toBe("1706.03762");
    expect(extractArxivIdFromText("https://arxiv.org/abs/2301.00001v2")).toBe("2301.00001v2");
    expect(extractArxivIdFromText("arxiv:2301.00001")).toBe("2301.00001");
  });
});

describe("Unpaywall lookup", () => {
  it("treats an unknown DOI (404) as no record, not a failure", async () => {
    const { UnpaywallAdapter } = await import("../../src/lib/adapters/unpaywall.js");
    const { TroveError } = await import("../../src/lib/core/errors.js");
    const requestJson = vi.fn(async () => {
      throw new TroveError("Upstream unpaywall error (404)", "UPSTREAM_NON_OK", false, 404);
    });
    const adapter = new UnpaywallAdapter({ requestJson } as unknown as HttpClient, { contactEmail: "a@b.c" } as AppConfig);
    await expect(adapter.getByDoi("10.1/missing")).resolves.toBeNull();
  });
});
