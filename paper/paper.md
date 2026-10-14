---
title: 'Trove: a fail-closed scholarly retrieval server for language-model research agents'
tags:
  - TypeScript
  - Model Context Protocol
  - scholarly metadata
  - literature review
  - research software
  - large language models
authors:
  - name: Palash Lalwani
    orcid: 0009-0009-8270-6704
    corresponding: true
    affiliation: 1
affiliations:
  - name: Independent Researcher, India
    index: 1
date: 14 October 2026
bibliography: paper.bib
---


# Summary

Many researchers now use general-purpose language-model assistants to find,
read and compare scientific papers. Without access to real data, these
assistants often give references that look correct but do not exist, or that
exist but do not support the claim made [@walters2023fabrication]. Trove is an
open-source server that gives such an assistant tools backed by open scholarly
databases. These are OpenAlex [@priem2022openalex], Semantic Scholar
[@kinney2023semantic], arXiv [@arxivapi], PubMed [@ncbi_eutilities], Unpaywall
[@piwowar2018state], CORE [@knoth2023core] and Hugging Face Papers. Trove
implements the Model Context Protocol [@mcp2024], so any compatible client,
such as Claude Desktop, can call it. Its thirteen tools cover search,
identifier resolution, legal open-access full text, citation and reference
graphs, author and institution profiles, citation velocity and structured
comparison of papers.

Trove follows one rule throughout. When the evidence for an answer is missing,
it reports the gap instead of guessing. Every response carries a status, the
warnings raised during the call and a provenance record for each upstream
request. Both the assistant and the researcher reading its output can
therefore separate retrieved facts from missing ones.

# Statement of need

Literature search with a language model fails in two ways. The first is
fabrication, where the model writes a citation from memory instead of
retrieving it. Giving the model a search tool solves only part of this
problem. A tool that always returns some result simply shifts the error into
the tool. Suppose a similar-papers tool quietly falls back to keyword matching
when its semantic service is rate-limited, or a trending tool ranks papers by
total citations because no time series is available. The assistant then
receives a confident answer to a different question, and nothing in the
response tells it so.

The second failure is fragmentation. One paper can appear under a DOI, an
arXiv identifier, a PubMed ID, an OpenAlex work ID and a Semantic Scholar
corpus ID. Each index has different coverage of abstracts, references,
citation counts and open-access links. An assistant that queries only one
index inherits its gaps. An assistant that queries several without matching
identifiers returns the same paper more than once.

Trove is meant for researchers and students who use these assistants for
scoping reviews, related-work sections or reading in an unfamiliar field. It
gives them one set of tools over several open indexes and labels every
incomplete answer.

# State of the field

Several open-source projects already connect assistants to scholarly data.
`arxiv-mcp-server` [@arxivmcp] is centred on arXiv. It reads papers section by
section from their LaTeX source and takes citation graphs from Semantic
Scholar. Many smaller servers each wrap a single Semantic Scholar or OpenAlex
API. `paper-search-mcp` [@papersearchmcp] has the widest coverage. It searches
many sources in parallel, removes duplicate results and downloads PDFs through
a chain of open-access sources. Its focus is coverage and document retrieval.
`zotero-mcp` [@zoteromcp] works on a user's existing Zotero library and does
not discover new literature. Client libraries such as `pyalex` [@pyalex] wrap
one API for use in programs and are not designed as tools for an assistant.

Trove does not try to reach more sources than these projects. Its contribution
is a stricter contract on what it returns. To my knowledge, no existing tool
combines the following four properties. Each call returns a status and
provenance record that marks incomplete answers. Records keep a persistent
identity across indexes, so any identifier leads to the same paper. Citation
velocity is measured from locally stored snapshots and is never estimated from
totals. Tools refuse to answer rather than substitute a weaker method, and
release tests enforce this. Trove also limits full text to legal open-access
sources.

A separate line of work builds complete systems that write cited answers, for
example PaperQA2 [@skarlinski2024language] and OpenScholar
[@asai2024openscholar]. These systems control the whole pipeline, including
the language model, and are evaluated as question-answering systems. Trove
works at a lower level. It generates no text. Reasoning is left to whichever
assistant the researcher already uses, and Trove is responsible only for the
accuracy of the evidence it supplies and for reporting what it could not find.

I built Trove as a new project, and did not extend an existing server,
because these properties must be part of the data model and of every tool's
contract from the start. They are difficult to add to a server whose tools
pass each provider's output through directly.

# Software design

Trove is a TypeScript server of about 7,000 lines and is distributed on npm.
It runs over standard input and output for desktop clients, and over
streamable HTTP with bearer-token authentication for other clients. Four
design decisions shape it.

**A common response envelope.** Every tool returns the same structure. It has
a `status` of `ok`, `partial` or `error`, a `degraded` flag, a list of
`warnings`, a `provenance` list and the payload itself. Each provenance record
gives the source, endpoint, timestamp, licence, latency and whether the result
came from the local cache. Responses become longer, but an assistant can
report a gap only when the gap is visible to it.

**Refusal instead of approximation.** When a tool cannot obtain the evidence
its contract requires, Trove returns an explicit error or an `unavailable`
mode and does not fall back to a weaker method. `find_similar_papers` uses
only Semantic Scholar's recommendation service and will not switch to keyword
overlap. When no index has a usable reference list for a paper,
`get_references` returns a warning and suggests reading the full text. As a
result, some calls return nothing useful on a fresh installation. In return,
a non-empty answer always means what the tool's name says.

**Citation velocity from local snapshots.** None of the connected APIs
provides day-level citation history. OpenAlex, for example, gives current
totals and yearly counts only. Trove therefore stores a dated citation count
for each paper it sees in a local SQLite database, and computes velocity only
from the difference between these snapshots. `get_trending_papers` returns
`mode = snapshot` only when a paper has at least two snapshot dates and
non-zero growth. Otherwise it returns `mode = unavailable` along with counts
that explain why. A `sync` command collects snapshots on a schedule. The
drawback is that trending results need at least one day of history, and the
documentation states this as expected behaviour.

**Deterministic identity, ranking and synthesis.** Trove merges records from
all indexes under one canonical identifier, chosen in a fixed order. An arXiv
ID comes first when the DOI was issued by arXiv. After that come the DOI, the
PubMed ID, the Semantic Scholar ID, the OpenAlex ID and, as a last resort, the
normalised title with the year. Every known alias is stored, so a later lookup
by any of these identifiers returns the same record. Ranking uses a simple
score built from matches in the title, abstract and topics, citation count,
year and open-access availability. Each result lists the `reasons` behind its
score. A precision filter removes results that miss the distinctive words of
the query, which reduces off-topic results from broad indexes. The tools that
build evidence maps, namely `build_literature_map`, `compare_papers` and
`trace_idea`, are extractive. They select and label sentences from abstracts
or legally obtained full text and attach the source paper's ID to each
sentence. They refuse when the evidence across papers is too uneven for a fair
comparison. I chose rules that a reviewer can read over a trained model. This
lowers recall, but every output can be traced back to its source.

Full text comes only from legal open-access sources, tried in the order arXiv,
Unpaywall and CORE. Rate limits from upstream services are handled with
`Retry-After`-based waiting and reported as warnings.

The test suite checks these contracts directly. Along with unit tests for
identifiers, duplicate removal, ranking and text extraction, a set of
release-gate tests fails the build if the server returns trending results
without velocity data, similarity results without Semantic Scholar, or a
literature map or comparison built on weak or one-sided evidence. These gates
run before every npm release. Separate live tests check the response format
of each provider.

# Research impact statement

I built Trove as a private tool for my own literature work and released it as
open source on npm and GitHub in March 2026. I first used it in January 2026
for the literature review of my seminar paper on International Environmental
Law, which is now nearly complete. In that work I used Trove to find the
literature I needed to review and to identify gaps in it before finalising
the scope and moving to a more detailed literature review. Trove is published
on npm as `trove-mcp` and is listed in the official Model Context Protocol
registry. TODO: confirm the listing after publishing.

# AI usage disclosure

I used generative AI tools while developing this software and while preparing
this paper. The source code was written jointly by me and Anthropic's Claude
Code, using the Claude Sonnet 5, Claude Opus 5 and Claude Opus 5.5 models.
Roughly half of the implementation was
AI-assisted. I designed the architecture, including the response envelope,
the refusal-based tool contracts, the identity-matching scheme and the
snapshot-based velocity method, and I specified the release-gate tests that
enforce them. Claude Code, using the Claude Opus 5.5 model, helped draft this
paper from the source code and README. I checked every factual
statement about the software against the code and its test suite. I have
reviewed, edited and validated all AI-assisted code, documentation and text,
and I take full responsibility for it.

# Acknowledgements

This work received no financial support. Trove depends on public APIs
maintained by OpenAlex, the Allen Institute for AI's Semantic Scholar, arXiv,
the U.S. National Library of Medicine, Unpaywall, CORE and Hugging Face.

# References
