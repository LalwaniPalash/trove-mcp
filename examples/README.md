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
| 1 | `search_papers` | `partial` | Ten relevant papers from 1986 to 2026. Trove queried five sources. Semantic Scholar returned HTTP 429, as it often does without a key, and the envelope says so. |
| 2 | `get_paper` | `ok` | The top result resolved to one canonical record. |
| 3 | `get_full_text` | `partial` | The first paper's listed PDF location is an HTML page, not a PDF, and neither Unpaywall nor CORE has a copy. Trove returns no text and says why. |
| 4 | `get_full_text` | `ok` | The next paper's open-access PDF, found through its OpenAlex location, read in 20 sections. |
| 5 | `build_literature_map` | `partial` | Claims, methods and limitations from five papers, each sentence tagged with its source paper ID. Two publisher servers were too slow to answer in time, so the map marks its evidence as below the preferred threshold. |
| 6 | `get_trending_papers` | `partial`, `mode = unavailable` | A new database has no citation history. Trove seeds today's counts and refuses to rank by total citations. |
| 7 | `find_similar_papers` | `error` | Without `SEMANTIC_SCHOLAR_API_KEY`, Trove refuses instead of falling back to keyword overlap. |

The `partial` and `error` results above come from the outside world: a rate-limited
provider, broken or slow publisher links, a database with no history yet, and a
missing key. Every one of them is named in `warnings` and `provenance`, so the
assistant can tell the researcher what it could not check. With
`SEMANTIC_SCHOLAR_API_KEY` set, step 7 returns recommendations and step 1 is far less
likely to be rate-limited. After `trove-mcp sync` has run on two different days,
step 6 can rank by measured citation growth.
