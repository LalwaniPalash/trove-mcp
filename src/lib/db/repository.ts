import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalPaperId, dedupePapers, paperAliasIds } from "../core/dedupe.js";
import type {
  CanonicalAuthor,
  CanonicalInstitution,
  CanonicalPaper,
  FullTextPayload,
} from "../types/common.js";

interface CachedEntry<T> {
  value: T;
  expiresAtEpochMs: number;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

export class TroveRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const directory = path.dirname(dbPath);
      if (directory && directory !== ".") {
        fs.mkdirSync(directory, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        doi TEXT,
        arxiv_id TEXT,
        pubmed_id TEXT,
        s2_id TEXT,
        openalex_id TEXT,
        year INTEGER,
        citation_count INTEGER,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
      CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id);
      CREATE INDEX IF NOT EXISTS idx_papers_pubmed ON papers(pubmed_id);
      CREATE INDEX IF NOT EXISTS idx_papers_s2 ON papers(s2_id);
      CREATE INDEX IF NOT EXISTS idx_papers_openalex ON papers(openalex_id);

      CREATE TABLE IF NOT EXISTS paper_aliases (
        alias_id TEXT PRIMARY KEY,
        canonical_paper_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS institutions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citation_edges (
        source_paper_id TEXT NOT NULL,
        target_paper_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        influence_score REAL,
        year INTEGER,
        PRIMARY KEY (source_paper_id, target_paper_id, edge_type)
      );

      CREATE TABLE IF NOT EXISTS full_text_cache (
        paper_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        availability TEXT NOT NULL,
        source_url TEXT,
        chunks_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_cache (
        cache_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        expires_at_epoch_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citation_snapshots (
        paper_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        citation_count INTEGER NOT NULL,
        PRIMARY KEY (paper_id, snapshot_date)
      );

      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        last_ok_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT,
        status_json TEXT
      );
    `);

    // Drop stale provider health rows for providers removed from active runtime flows.
    this.db.prepare(`DELETE FROM source_health WHERE source = 'paperswithcode'`).run();
    this.rebuildPaperAliases();
  }

  upsertPaper(paper: CanonicalPaper): void {
    const canonicalId = canonicalPaperId(paper);
    const canonicalPaper: CanonicalPaper = { ...paper, id: canonicalId };
    const existing = this.getPaperByCanonicalId(canonicalId);
    const merged = existing ? dedupePapers([existing, canonicalPaper])[0] : canonicalPaper;

    const stmt = this.db.prepare(`
      INSERT INTO papers (
        id, title, doi, arxiv_id, pubmed_id, s2_id, openalex_id,
        year, citation_count, data_json, updated_at
      ) VALUES (
        @id, @title, @doi, @arxiv_id, @pubmed_id, @s2_id, @openalex_id,
        @year, @citation_count, @data_json, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        doi = excluded.doi,
        arxiv_id = excluded.arxiv_id,
        pubmed_id = excluded.pubmed_id,
        s2_id = excluded.s2_id,
        openalex_id = excluded.openalex_id,
        year = excluded.year,
        citation_count = excluded.citation_count,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      id: merged.id,
      title: merged.title,
      doi: merged.doi ?? null,
      arxiv_id: merged.arxivId ?? null,
      pubmed_id: merged.pubmedId ?? null,
      s2_id: merged.s2Id ?? null,
      openalex_id: merged.openAlexId ?? null,
      year: merged.year ?? null,
      citation_count: merged.citationCount ?? null,
      data_json: toJson(merged),
      updated_at: new Date().toISOString(),
    });

    this.registerPaperAliases(merged, paper.id);
    this.rekeyPaperArtifacts(paperAliasIds({ ...merged, id: paper.id }), merged.id);

    if (paper.id !== merged.id) {
      this.db.prepare("DELETE FROM papers WHERE id = ?").run(paper.id);
    }
  }

  getPaperByCanonicalId(id: string): CanonicalPaper | null {
    const row = this.db
      .prepare("SELECT data_json FROM papers WHERE id = ?")
      .get(id) as { data_json: string } | undefined;

    if (!row) {
      return null;
    }

    return fromJson<CanonicalPaper>(row.data_json);
  }

  getPaperByIdentifier(identifier: string): CanonicalPaper | null {
    const normalized = identifier.trim().toLowerCase();
    const canonicalId = this.resolveCanonicalPaperId(normalized);
    if (canonicalId) {
      return this.getPaperByCanonicalId(canonicalId);
    }

    const row = this.db
      .prepare(
        `SELECT data_json FROM papers
         WHERE lower(id) = @id
            OR lower(doi) = @doi
            OR lower(arxiv_id) = @arxiv
            OR lower(pubmed_id) = @pubmed
            OR lower(s2_id) = @s2
            OR lower(openalex_id) = @openalex
         LIMIT 1`,
      )
      .get({
        id: normalized,
        doi: normalized,
        arxiv: normalized.replace(/^arxiv:/, ""),
        pubmed: normalized.replace(/^pmid:/, ""),
        s2: normalized.replace(/^s2:/, ""),
        openalex: normalized,
      }) as { data_json: string } | undefined;

    if (!row) {
      return null;
    }

    return fromJson<CanonicalPaper>(row.data_json);
  }

  findPapersByTitleFragment(fragment: string, limit = 10): CanonicalPaper[] {
    const rows = this.db
      .prepare(
        `SELECT data_json FROM papers
         WHERE lower(title) LIKE @pattern
         ORDER BY COALESCE(citation_count, 0) DESC
         LIMIT @limit`,
      )
      .all({
        pattern: `%${fragment.toLowerCase()}%`,
        limit,
      }) as Array<{ data_json: string }>;

    return rows
      .map((row) => fromJson<CanonicalPaper>(row.data_json))
      .filter((paper): paper is CanonicalPaper => Boolean(paper));
  }

  upsertAuthor(author: CanonicalAuthor): void {
    this.db
      .prepare(
        `INSERT INTO authors (id, name, data_json, updated_at)
         VALUES (@id, @name, @data_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: author.id,
        name: author.name,
        data_json: toJson(author),
        updated_at: new Date().toISOString(),
      });
  }

  getAuthor(idOrName: string): CanonicalAuthor | null {
    const normalized = idOrName.toLowerCase();
    const row = this.db
      .prepare(
        `SELECT data_json FROM authors
         WHERE lower(id) = @value OR lower(name) = @value
         LIMIT 1`,
      )
      .get({ value: normalized }) as { data_json: string } | undefined;

    if (!row) {
      return null;
    }
    return fromJson<CanonicalAuthor>(row.data_json);
  }

  upsertInstitution(institution: CanonicalInstitution): void {
    this.db
      .prepare(
        `INSERT INTO institutions (id, name, data_json, updated_at)
         VALUES (@id, @name, @data_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: institution.id,
        name: institution.name,
        data_json: toJson(institution),
        updated_at: new Date().toISOString(),
      });
  }

  getInstitution(idOrName: string): CanonicalInstitution | null {
    const normalized = idOrName.toLowerCase();
    const row = this.db
      .prepare(
        `SELECT data_json FROM institutions
         WHERE lower(id) = @value OR lower(name) = @value
         LIMIT 1`,
      )
      .get({ value: normalized }) as { data_json: string } | undefined;

    if (!row) {
      return null;
    }
    return fromJson<CanonicalInstitution>(row.data_json);
  }

  upsertFullText(payload: FullTextPayload): void {
    const canonicalPaperId = this.resolveCanonicalPaperId(payload.paperId) ?? payload.paperId;
    const normalizedPayload: FullTextPayload = {
      ...payload,
      paperId: canonicalPaperId,
    };
    this.db
      .prepare(
        `INSERT INTO full_text_cache (paper_id, source, availability, source_url, chunks_json, updated_at)
         VALUES (@paper_id, @source, @availability, @source_url, @chunks_json, @updated_at)
         ON CONFLICT(paper_id) DO UPDATE SET
           source = excluded.source,
           availability = excluded.availability,
           source_url = excluded.source_url,
           chunks_json = excluded.chunks_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        paper_id: normalizedPayload.paperId,
        source: normalizedPayload.source,
        availability: normalizedPayload.availability,
        source_url: normalizedPayload.sourceUrl ?? null,
        chunks_json: toJson(normalizedPayload),
        updated_at: new Date().toISOString(),
      });
  }

  getFullText(paperId: string): FullTextPayload | null {
    const canonicalPaperId = this.resolveCanonicalPaperId(paperId) ?? paperId;
    const row = this.db
      .prepare("SELECT chunks_json FROM full_text_cache WHERE paper_id = ?")
      .get(canonicalPaperId) as { chunks_json: string } | undefined;

    if (!row) {
      return null;
    }
    return fromJson<FullTextPayload>(row.chunks_json);
  }

  deleteFullText(paperId: string): void {
    const canonicalPaperId = this.resolveCanonicalPaperId(paperId) ?? paperId;
    this.db.prepare("DELETE FROM full_text_cache WHERE paper_id = ?").run(canonicalPaperId);
  }

  deleteFullTextMany(paperIds: string[]): number {
    if (!paperIds.length) {
      return 0;
    }

    const deleteOne = this.db.prepare("DELETE FROM full_text_cache WHERE paper_id = ?");
    const tx = this.db.transaction((ids: string[]) => {
      let count = 0;
      for (const id of ids) {
        const result = deleteOne.run(id);
        count += result.changes;
      }
      return count;
    });
    return tx(paperIds);
  }

  getFullTextEntries(limit: number, offset = 0): Array<{ paperId: string; payload: FullTextPayload }> {
    const rows = this.db
      .prepare(
        `SELECT paper_id, chunks_json
         FROM full_text_cache
         ORDER BY updated_at ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ limit, offset }) as Array<{ paper_id: string; chunks_json: string }>;

    return rows
      .map((row) => ({
        paperId: row.paper_id,
        payload: fromJson<FullTextPayload>(row.chunks_json),
      }))
      .filter((row): row is { paperId: string; payload: FullTextPayload } => Boolean(row.payload));
  }

  setCache<T>(key: string, value: T, ttlMs: number): void {
    this.db
      .prepare(
        `INSERT INTO query_cache (cache_key, response_json, expires_at_epoch_ms, updated_at)
         VALUES (@cache_key, @response_json, @expires_at_epoch_ms, @updated_at)
         ON CONFLICT(cache_key) DO UPDATE SET
           response_json = excluded.response_json,
           expires_at_epoch_ms = excluded.expires_at_epoch_ms,
           updated_at = excluded.updated_at`,
      )
      .run({
        cache_key: key,
        response_json: toJson(value),
        expires_at_epoch_ms: Date.now() + ttlMs,
        updated_at: new Date().toISOString(),
      });
  }

  getCache<T>(key: string): CachedEntry<T> | null {
    const row = this.db
      .prepare(
        `SELECT response_json, expires_at_epoch_ms
         FROM query_cache
         WHERE cache_key = @cache_key`,
      )
      .get({ cache_key: key }) as
      | { response_json: string; expires_at_epoch_ms: number }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      value: JSON.parse(row.response_json) as T,
      expiresAtEpochMs: row.expires_at_epoch_ms,
    };
  }

  saveCitationSnapshot(paperId: string, citationCount: number, snapshotDate?: string): void {
    const canonicalPaperId = this.resolveCanonicalPaperId(paperId) ?? paperId;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO citation_snapshots (paper_id, snapshot_date, citation_count)
         VALUES (@paper_id, @snapshot_date, @citation_count)`,
      )
      .run({
        paper_id: canonicalPaperId,
        snapshot_date: snapshotDate ?? new Date().toISOString().slice(0, 10),
        citation_count: citationCount,
      });
  }

  getCitationVelocity(paperId: string, daysBack: number): number {
    const canonicalPaperId = this.resolveCanonicalPaperId(paperId) ?? paperId;
    const rows = this.db
      .prepare(
        `SELECT snapshot_date, citation_count
         FROM citation_snapshots
         WHERE paper_id = @paper_id
         ORDER BY snapshot_date ASC`,
      )
      .all({ paper_id: canonicalPaperId }) as Array<{ snapshot_date: string; citation_count: number }>;

    if (rows.length < 2) {
      return 0;
    }

    const latest = rows.at(-1);
    if (!latest) {
      return 0;
    }

    const startCutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const baseline = rows.find((row) => new Date(row.snapshot_date).getTime() >= startCutoff);

    if (!baseline) {
      return latest.citation_count - rows[0].citation_count;
    }

    return latest.citation_count - baseline.citation_count;
  }

  getCitationSnapshotCount(paperId: string): number {
    const canonicalPaperId = this.resolveCanonicalPaperId(paperId) ?? paperId;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM citation_snapshots
         WHERE paper_id = @paper_id`,
      )
      .get({ paper_id: canonicalPaperId }) as { count: number };
    return row.count;
  }

  markSourceOk(source: string): void {
    this.db
      .prepare(
        `INSERT INTO source_health (source, last_ok_at, status_json)
         VALUES (@source, @last_ok_at, @status_json)
         ON CONFLICT(source) DO UPDATE SET
           last_ok_at = excluded.last_ok_at,
           status_json = excluded.status_json`,
      )
      .run({
        source,
        last_ok_at: new Date().toISOString(),
        status_json: toJson({ status: "ok" }),
      });
  }

  markSourceError(source: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO source_health (source, last_error_at, last_error_message, status_json)
         VALUES (@source, @last_error_at, @last_error_message, @status_json)
         ON CONFLICT(source) DO UPDATE SET
           last_error_at = excluded.last_error_at,
           last_error_message = excluded.last_error_message,
           status_json = excluded.status_json`,
      )
      .run({
        source,
        last_error_at: new Date().toISOString(),
        last_error_message: message,
        status_json: toJson({ status: "error", message }),
      });
  }

  getSourceHealth(): Array<{ source: string; status: Record<string, unknown> | null }> {
    const rows = this.db
      .prepare(`SELECT source, status_json FROM source_health ORDER BY source ASC`)
      .all() as Array<{ source: string; status_json: string | null }>;

    return rows.map((row) => ({
      source: row.source,
      status: fromJson<Record<string, unknown>>(row.status_json),
    })).filter((row) => row.source !== "paperswithcode");
  }

  getCacheStats(): { papers: number; fullTexts: number; cachedQueries: number; snapshots: number } {
    const papers = this.db.prepare("SELECT COUNT(*) as count FROM papers").get() as { count: number };
    const fullTexts = this.db
      .prepare("SELECT COUNT(*) as count FROM full_text_cache")
      .get() as { count: number };
    const cachedQueries = this.db
      .prepare("SELECT COUNT(*) as count FROM query_cache")
      .get() as { count: number };
    const snapshots = this.db
      .prepare("SELECT COUNT(*) as count FROM citation_snapshots")
      .get() as { count: number };

    return {
      papers: papers.count,
      fullTexts: fullTexts.count,
      cachedQueries: cachedQueries.count,
      snapshots: snapshots.count,
    };
  }

  resolveCanonicalPaperId(identifier: string): string | null {
    const normalized = identifier.trim().toLowerCase();
    const row = this.db
      .prepare(
        `SELECT canonical_paper_id
         FROM paper_aliases
         WHERE alias_id = @alias_id
         LIMIT 1`,
      )
      .get({ alias_id: normalized }) as { canonical_paper_id: string } | undefined;

    return row?.canonical_paper_id ?? null;
  }

  private registerPaperAliases(paper: CanonicalPaper, originalId?: string): void {
    const aliases = new Set(paperAliasIds(paper));
    if (originalId) {
      aliases.add(originalId.trim().toLowerCase());
    }
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO paper_aliases (alias_id, canonical_paper_id)
       VALUES (@alias_id, @canonical_paper_id)`,
    );
    for (const aliasId of aliases) {
      stmt.run({
        alias_id: aliasId,
        canonical_paper_id: paper.id,
      });
    }
  }

  private rekeyPaperArtifacts(ids: string[], canonicalId: string): void {
    const aliasIds = Array.from(new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean)));
    for (const aliasId of aliasIds) {
      if (aliasId === canonicalId) {
        continue;
      }

      const fullText = this.db
        .prepare("SELECT chunks_json FROM full_text_cache WHERE paper_id = ?")
        .get(aliasId) as { chunks_json: string } | undefined;
      if (fullText) {
        const payload = fromJson<FullTextPayload>(fullText.chunks_json);
        if (payload) {
          this.upsertFullText({ ...payload, paperId: canonicalId });
        }
        this.db.prepare("DELETE FROM full_text_cache WHERE paper_id = ?").run(aliasId);
      }

      const snapshots = this.db
        .prepare(
          `SELECT snapshot_date, citation_count
           FROM citation_snapshots
           WHERE paper_id = @paper_id`,
        )
        .all({ paper_id: aliasId }) as Array<{ snapshot_date: string; citation_count: number }>;

      for (const snapshot of snapshots) {
        this.saveCitationSnapshot(canonicalId, snapshot.citation_count, snapshot.snapshot_date);
      }
      this.db.prepare("DELETE FROM citation_snapshots WHERE paper_id = ?").run(aliasId);
    }
  }

  private rebuildPaperAliases(): void {
    const rows = this.db
      .prepare("SELECT id, data_json FROM papers ORDER BY updated_at ASC")
      .all() as Array<{ id: string; data_json: string }>;

    const tx = this.db.transaction((records: Array<{ id: string; data_json: string }>) => {
      this.db.prepare("DELETE FROM paper_aliases").run();
      for (const row of records) {
        const paper = fromJson<CanonicalPaper>(row.data_json);
        if (!paper) {
          continue;
        }

        const canonicalId = canonicalPaperId(paper);
        const normalizedPaper: CanonicalPaper = { ...paper, id: canonicalId };
        const existing = this.getPaperByCanonicalId(canonicalId);
        const merged = existing ? dedupePapers([existing, normalizedPaper])[0] : normalizedPaper;

        this.db
          .prepare(
            `INSERT OR REPLACE INTO papers (
              id, title, doi, arxiv_id, pubmed_id, s2_id, openalex_id,
              year, citation_count, data_json, updated_at
            ) VALUES (
              @id, @title, @doi, @arxiv_id, @pubmed_id, @s2_id, @openalex_id,
              @year, @citation_count, @data_json, @updated_at
            )`,
          )
          .run({
            id: merged.id,
            title: merged.title,
            doi: merged.doi ?? null,
            arxiv_id: merged.arxivId ?? null,
            pubmed_id: merged.pubmedId ?? null,
            s2_id: merged.s2Id ?? null,
            openalex_id: merged.openAlexId ?? null,
            year: merged.year ?? null,
            citation_count: merged.citationCount ?? null,
            data_json: toJson(merged),
            updated_at: new Date().toISOString(),
          });

        this.registerPaperAliases(merged, row.id);
        this.rekeyPaperArtifacts([row.id, ...paperAliasIds({ ...paper, id: row.id })], merged.id);
        if (row.id !== merged.id) {
          this.db.prepare("DELETE FROM papers WHERE id = ?").run(row.id);
        }
      }
    });

    tx(rows);
  }
}
