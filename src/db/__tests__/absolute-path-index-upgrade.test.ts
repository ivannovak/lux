// An index written before paths were stored corpus-relative (schema 15 and earlier) is never read
// as if it were in the new form (issue #16): a read refuses it, and migrating clears it and says so.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { MigrationRunner } from '../migrations.js';
import { setDbNoticeHandler } from '../notices.js';
import { openIndex } from '../open-policy.js';
import { LuxSqlite } from '../sqlite-adapter.js';

const OLD_ROOT = '/Users/someone/code/repo';
const DERIVED_TABLES = [
  'knowledge_entries',
  'module_dependencies',
  'structural_nodes',
  'structural_edges',
  'edge_evidence',
  'structural_node_texts',
  'index_metadata',
];

let dir: string;
let dbPath: string;
let notices: string[];

function count(table: string): number {
  const raw = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (raw.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n;
  } finally {
    raw.close();
  }
}

function schemaVersion(): number {
  const raw = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (raw.get('SELECT MAX(version) AS v FROM schema_version') as { v: number }).v;
  } finally {
    raw.close();
  }
}

/** Write an index as schema 15 left it: absolute paths in both columns and in the trust state. */
function writeSchema15Index(): void {
  new LuxDatabase(dbPath).close();
  const raw = new LuxSqlite(dbPath);
  try {
    raw.run('DELETE FROM schema_version WHERE version > 15');
    raw.run('INSERT INTO knowledge_entries (type, title, file_path, content) VALUES (?, ?, ?, ?)', [
      'general',
      'Readme',
      `${OLD_ROOT}/README.md`,
      'settlement notes',
    ]);
    raw.run(
      'INSERT INTO module_dependencies (source_module, target_module, reference_count, sample_files) VALUES (?, ?, ?, ?)',
      ['A', 'B', 1, JSON.stringify([`${OLD_ROOT}/src/A/x.php`])]
    );
    raw.run(
      'INSERT INTO structural_nodes (id, node_type, file_path, language_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['file:src/A/x.php', 'file', 'src/A/x.php', 'php', 1]
    );
    raw.run('INSERT INTO index_metadata (key, value) VALUES (?, ?)', [
      'last_indexed_commit',
      'abc123',
    ]);
    raw.run('INSERT INTO index_metadata (key, value) VALUES (?, ?)', [
      'overlay_trust_state',
      JSON.stringify({ mode: 'overlay-complete', repoPath: OLD_ROOT, warnings: [] }),
    ]);
    raw.run('INSERT INTO events (source, event_type, summary) VALUES (?, ?, ?)', [
      'cli',
      'lux_usage_event',
      'kept',
    ]);
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-abs-upgrade-'));
  dbPath = join(dir, 'lux.db');
  notices = [];
  setDbNoticeHandler((kind, message) => {
    if (kind === 'notice') notices.push(message);
  });
});
afterEach(() => {
  setDbNoticeHandler(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('an index that stored absolute paths', () => {
  it('this build expects a schema newer than 15', () => {
    expect(MigrationRunner.latestVersion()).toBeGreaterThanOrEqual(16);
  });

  it.each(['read-existing', 'write-existing'] as const)(
    'is refused by a %s open, and left exactly as it was',
    (mode) => {
      writeSchema15Index();

      const opened = openIndex(dbPath, mode);

      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.refusal).toBe('schema-too-old');
        expect(opened.message).toMatch(/lux migrate up|lux index rebuild/);
      }
      expect(schemaVersion()).toBe(15);
      expect(count('knowledge_entries')).toBe(1);
      expect(count('module_dependencies')).toBe(1);
    }
  );

  it('is cleared when migrated, never rewritten in part, and the migration says so once', () => {
    writeSchema15Index();

    new LuxDatabase(dbPath).close();

    expect(schemaVersion()).toBe(MigrationRunner.latestVersion());
    for (const table of DERIVED_TABLES) expect(count(table), table).toBe(0);
    expect(count('events')).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/stored absolute file paths/);
    expect(notices[0]).toMatch(/lux index rebuild/);
  });

  it('has no baseline after migrating, so the next sync rebuilds in full', () => {
    writeSchema15Index();
    const db = new LuxDatabase(dbPath);
    try {
      expect(db.getIndexMetadata('last_indexed_commit')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('can then be read: the refusal does not outlive the migration', () => {
    writeSchema15Index();
    new LuxDatabase(dbPath).close();

    const opened = openIndex(dbPath, 'read-existing');
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.db.getAllKnowledgeEntries()).toEqual([]);
      opened.db.close();
    }
  });
});

describe('a database with nothing to lose', () => {
  it('raises no notice when it is created', () => {
    new LuxDatabase(dbPath).close();
    expect(notices).toEqual([]);
  });

  it('raises no notice when a current index is reopened', () => {
    const db = new LuxDatabase(dbPath);
    db.insertKnowledgeEntry({ type: 'general', title: 'T', file_path: 'README.md', content: 'c' });
    db.close();
    new LuxDatabase(dbPath).close();
    expect(notices).toEqual([]);
    expect(count('knowledge_entries')).toBe(1);
  });
});
