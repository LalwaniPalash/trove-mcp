# Worked example: scoping a literature review

`literature-review.ts` runs Trove the way an assistant would during the scoping stage
of a literature review. It starts the built server over stdio, calls six tools in order,
and saves every response envelope to `output/<query>/`.

```bash
npm install
npm run build
TROVE_CONTACT_EMAIL=you@example.com UNPAYWALL_EMAIL=you@example.com \
  npm run example -- "transboundary environmental harm international law"
```

Each run uses a new, empty database, so no answer comes from an earlier cache.
Results depend on the live state of each provider, so your output will differ in detail.

## The recorded run

`output/transboundary-environmental-harm-international-law/` was recorded on
14 October 2026 with no Semantic Scholar or CORE key. The topic comes from the
International Environmental Law seminar in which Trove was first used.

| Step | Tool | Status | What the response shows |
|---|---|---|---|
| 1 | `search_papers` | `partial` | Ten relevant papers from 1986 to 2026. Trove queried five sources. Only OpenAlex and CORE records reached the top ten after ranking. Semantic Scholar returned HTTP 429, and the envelope says so. |
| 2 | `get_paper` | `ok` | The top result resolved to one canonical record. |
| 3 | `get_full_text` | `partial` | Unpaywall had no PDF and CORE returned HTTP 500. Trove reports "No full-text PDF source could be resolved." and returns no text. |
| 4 | `build_literature_map` | `partial` | Methods and limitations from five papers, each sentence tagged with its source paper ID. Four full-text fetches timed out, and the map says its evidence is below the preferred threshold. |
| 5 | `get_trending_papers` | `partial`, `mode = unavailable` | A new database has no citation history. Trove seeds today's counts and refuses to rank by total citations. |
| 6 | `find_similar_papers` | `error` | Without `SEMANTIC_SCHOLAR_API_KEY`, Trove refuses instead of falling back to keyword overlap. |

Only one call returned a clean `ok`, and that is the point of the example. Every gap,
including provider rate limits and server errors, appears in `warnings` and
`provenance`, so the assistant can tell the researcher what it could not check.
Set `SEMANTIC_SCHOLAR_API_KEY`, run `trove-mcp sync` on two different days, and steps 5
and 6 start returning results.
