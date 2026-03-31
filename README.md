# trove-mcp

[npm package](https://www.npmjs.com/package/trove-mcp) · [GitHub repo](https://github.com/LalwaniPalash/trove-mcp)

Trove is an MCP server for academic research.

The basic idea is simple: let Claude search papers, fetch metadata, read open full text when it can, and build structured outputs on top of that.

I have tried to keep it conservative. If a provider cannot support an answer well enough, Trove returns `partial`, `error`, or `unavailable` instead of pretending it knows more than it does.

## What it connects to

- OpenAlex (primary metadata, discovery, citations)
- Semantic Scholar (semantic recommendations and similarity)
- arXiv (preprint metadata and full text)
- Unpaywall (OA discovery by DOI)
- PubMed (biomedical indexing)
- Hugging Face Papers API (discovery context endpoints; strict trending uses citation snapshots only)
- CORE (full-text fallback)

## Install (Claude Desktop, stdio)

No local install is required with `npx`.

Quick smoke test:

```bash
npx -y trove-mcp@latest sync --queries="graph neural network"
```

Optional global install:

```bash
npm i -g trove-mcp
trove-mcp sync --queries="graph neural network"
```

### Claude Desktop on macOS

1. Open Claude Desktop.
2. Go to `Settings` -> `Developer` -> `Edit Config`.
3. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`.
4. Add this server entry under `mcpServers`:

```json
{
  "mcpServers": {
    "trove": {
      "command": "npx",
      "args": ["-y", "trove-mcp"],
      "env": {
        "TROVE_CONTACT_EMAIL": "you@example.com",
        "TROVE_DB_PATH": "/Users/you/.trove-mcp/trove.db",
        "SEMANTIC_SCHOLAR_API_KEY": "",
        "UNPAYWALL_EMAIL": "you@example.com",
        "CORE_API_KEY": ""
      }
    }
  }
}
```

5. Save the file and fully restart Claude Desktop.
6. Start a new chat and use Trove tools.

No API keys are required to start. Missing optional keys produce graceful partial/degraded responses.

## Using with Claude

If you want Claude to use Trove, just say so in the prompt.

Examples:

- "Use Trove to find papers on speculative decoding"
- "Use Trove to compare DPO and RLHF papers"
- "Use Trove to trace the origin of LoRA"

If you do not want Claude to touch the setup-sensitive tools, hide them with `TROVE_DISABLED_TOOLS`.

## What to expect on a fresh install

- `get_trending_papers` will usually return `mode = unavailable` on first run. Trove has to accumulate at least two local citation snapshot dates before it can compute citation velocity honestly.
- `find_similar_papers` is usable without a Semantic Scholar key only in theory. In practice, reliable semantic recommendations require `SEMANTIC_SCHOLAR_API_KEY`, and Trove says so directly.
- Some papers are retrievable even when their provider coverage is incomplete. For example, an arXiv preprint may have full text but no usable reference list in Semantic Scholar or OpenAlex.

## Runtime behavior

- Every tool returns a structured envelope with `status`, `degraded`, `warnings`, `provenance`, `meta.version`, and tool-specific `data`.
- Provider outages and rate limits are surfaced as warnings, not process crashes.
- Trove prefers explicit unavailability over approximate output. That is why some tools return empty results with warnings instead of "best effort" guesses.

### Tools with real prerequisites

- `get_trending_papers`
  - Strict fail-closed: only returns `mode = snapshot` when local citation history contains at least two snapshot dates and the computed velocity is non-zero.
  - Candidate discovery can come from OpenAlex, Semantic Scholar, and Hugging Face, but none of those official APIs provide day-level historical citation data.
  - First-run `mode = unavailable` is expected. Run `trove sync` once to seed, then rerun after a later day to accumulate history.
- `find_similar_papers`
  - Strict fail-closed: Semantic Scholar only, no lexical fallback.
  - Reliable use requires `SEMANTIC_SCHOLAR_API_KEY`.
  - Without a key, Trove returns an explicit error immediately instead of spending time on unreliable unauthenticated requests.

### Known provider constraints

- Semantic Scholar is publicly accessible without a key, but unauthenticated traffic uses a shared pool and often returns `429`.
- Unpaywall is only used when `UNPAYWALL_EMAIL` or `TROVE_CONTACT_EMAIL` is set.
- CORE works without a key for basic access but may rate-limit or degrade under load; `CORE_API_KEY` improves throughput. Also the CORE API is free, you just need to signup on their site and verify your mail address.
- `get_references` is strict fail-closed. Some large institutional arXiv preprints are retrievable as papers but still lack usable reference coverage in both Semantic Scholar and OpenAlex. In those cases Trove returns an explicit warning and suggests `get_full_text` for inline citation inspection.
- `get_author` returns `mostCitedPaperIds` and `recentPaperIds` as best-effort enrichment. If those follow-up lists cannot be fetched reliably, Trove returns the profile as `partial` and does not cache empty arrays as authoritative.
- OpenAlex-heavy search can still be domain-ambiguous for niche queries. `search_papers` and `build_literature_map` apply precision gates, but overloaded terms may still need tighter prompts or filters.
- `trace_idea` uses heuristic origin ranking. The timeline is often useful, but the earliest canonical paper can still be missed when provider ranking is imperfect.

## A practical setup

If you just want the useful core workflow, this is enough:

- `TROVE_CONTACT_EMAIL`
- `UNPAYWALL_EMAIL`
- `TROVE_DB_PATH`

If you want similar-paper recommendations to work reliably, also set:

- `SEMANTIC_SCHOLAR_API_KEY`

If you want trending to become useful, run:

```bash
npx -y trove-mcp@latest sync
```

and do that on a schedule. Trending depends on local snapshot history, so it will not be useful on day one.

If you want a more conservative setup, you can hide the tools that need extra setup:

```json
{
  "mcpServers": {
    "trove": {
      "command": "npx",
      "args": ["-y", "trove-mcp"],
      "env": {
        "TROVE_CONTACT_EMAIL": "you@example.com",
        "TROVE_DB_PATH": "/Users/you/.trove-mcp/trove.db",
        "UNPAYWALL_EMAIL": "you@example.com",
        "TROVE_DISABLED_TOOLS": "get_trending_papers,find_similar_papers"
      }
    }
  }
}
```

That gives you the core paper-search / paper-read / compare / trace workflow without exposing the two tools that are most sensitive to setup.

## HTTP mode (streamable)

```bash
TROVE_HTTP_BEARER_TOKEN=change-me npx trove-mcp --transport=http --port=3000
```

Browser client example:

```bash
TROVE_HTTP_BEARER_TOKEN=change-me TROVE_HTTP_CORS_ORIGIN=http://localhost:3000 npx trove-mcp --transport=http --port=3000
```

- `POST /mcp` for authenticated MCP requests
- `GET /health` for health checks
- Auth header: `Authorization: Bearer <token>`
- CORS exposes `Mcp-Session-Id`/`MCP-Session-Id` for browser MCP clients

## Tools

| Tool | What it does |
|---|---|
| `search_papers` | Multi-source search + dedupe + deterministic ranking (OpenAlex/S2/arXiv/PubMed/CORE) |
| `get_trending_papers` | Topic papers ranked by citation velocity with `mode = snapshot | unavailable` |
| `get_paper` | Resolve paper by DOI/arXiv/S2/OpenAlex/PubMed/title |
| `get_full_text` | arXiv -> Unpaywall -> CORE full-text fallback with chunked output |
| `get_citations` | Papers that cite a target paper |
| `get_references` | Papers referenced by a target paper |
| `find_similar_papers` | Semantic Scholar recommendations; reliable use requires `SEMANTIC_SCHOLAR_API_KEY` |
| `get_author` | Author profile and impact metrics; paper-list enrichment is best-effort |
| `get_institution_output` | Institution profile + publication output |
| `get_coauthor_network` | Collaboration graph around an author |
| `build_literature_map` | Structured evidence map (claims/methods/limitations/consensus) |
| `compare_papers` | Structured 2-5 paper comparison |
| `trace_idea` | Concept lineage across time and influence |

## Resources

- `trove://resources/version`
- `trove://resources/source-capability-matrix`
- `trove://resources/schema-reference`
- `trove://resources/cache-health`

## Prompts

- `literature-review-workflow`
- `paper-comparison-workflow`
- `idea-lineage-workflow`

These are optional workflow helpers.

## Sync job for citation snapshots

```bash
npx trove-mcp sync
npx trove-mcp sync --queries="agentic ai,graph neural network,causal inference"
```

Run this on a schedule (e.g. cron) to improve `get_trending_papers` quality.
Without older local snapshots, first-run trending results will correctly return `mode = unavailable`.
If you want actual short-window trending, run this at least twice on different days.

## Tests

The tests are mostly there to protect the parts that are easy to quietly break:

- identifier normalization
- dedupe / alias handling
- ranking and off-topic filtering
- full-text cleanup quality
- synthesis extraction quality
- fail-closed provider behavior
- release gates for fake trending / fake similarity / weak evidence
- live provider contract checks

`npm run verify:release` is in the publish path. Live tests are separate because they depend on upstream providers behaving that day.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:quality
npm run verify:release
npm run build
npm run inspect
```

Live-contract tests:

```bash
LIVE_CONTRACT=1 npm run test:live
```

Temporarily hide tools from MCP registration (for strict release gating):

```bash
TROVE_DISABLED_TOOLS=get_trending_papers,find_similar_papers npx -y trove-mcp@latest
```

## Data and compliance

- No scraping
- No Sci-Hub or paywalled bypassing
- All sources are public/open APIs or legal OA links

## License

MIT
