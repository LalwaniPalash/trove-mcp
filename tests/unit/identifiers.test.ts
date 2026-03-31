import { describe, expect, it } from "vitest";
import { parseIdentifier } from "../../src/lib/core/identifiers.js";

describe("parseIdentifier", () => {
  it("normalizes doi: prefixed DOI values", () => {
    const parsed = parseIdentifier("doi:10.1000/xyz123");
    expect(parsed).toEqual({ type: "doi", value: "10.1000/xyz123" });
  });

  it("normalizes arXiv abs URL into arxiv identifier", () => {
    const parsed = parseIdentifier("https://arxiv.org/abs/2302.07842");
    expect(parsed).toEqual({ type: "arxiv", value: "2302.07842" });
  });

  it("normalizes arXiv pdf URL into arxiv identifier", () => {
    const parsed = parseIdentifier("https://arxiv.org/pdf/2302.07842.pdf");
    expect(parsed).toEqual({ type: "arxiv", value: "2302.07842" });
  });

  it("routes 10.48550/arXiv DOIs to arxiv-first resolution path", () => {
    const parsed = parseIdentifier("10.48550/arXiv.2205.11916");
    expect(parsed).toEqual({ type: "arxiv", value: "2205.11916" });
  });
});
