import { existsSync } from 'node:fs';
import { LuxDatabase, reclaimStaleIndexLock } from './index.js';
import { MigrationRunner } from './migrations.js';
import { LuxSqlite } from './sqlite-adapter.js';

/** The three intentional ways callers may open the primary Lux index. */
export type IndexOpenMode = 'read-existing' | 'write-existing' | 'create-or-migrate';

/** Stable refusal reasons that CLI and MCP adapters can map to their own envelopes. */
export type IndexOpenRefusal =
  'index-absent' | 'schema-too-old' | 'schema-too-new' | 'db-unreadable';

export type IndexOpenResult =
  | { ok: true; db: LuxDatabase; schemaVersion: number }
  | { ok: false; refusal: IndexOpenRefusal; message: string };

type SchemaInspection =
  | { status: 'absent' }
  | { status: 'present'; version: number }
  | { status: 'unreadable'; message: string };

/**
 * Inspect only the migration ledger, using a file-must-exist, read-only handle.
 * In particular, do not construct MigrationRunner here: its constructor creates
 * schema_version when absent, which would make a nominal inspection a write.
 */
function inspectExistingSchema(dbPath: string): SchemaInspection {
  if (!existsSync(dbPath)) return { status: 'absent' };

  let db: LuxSqlite | undefined;
  try {
    db = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
    const ledger = db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
    ) as { name?: string } | undefined;
    if (!ledger?.name) return { status: 'present', version: 0 };

    const row = db.get('SELECT MAX(version) AS version FROM schema_version') as {
      version: number | null;
    };
    return { status: 'present', version: row.version ?? 0 };
  } catch (error) {
    // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
    return { status: 'unreadable', message: errorMessage(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
      // The open/query error is the useful refusal; malformed databases may also reject close.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(dbPath: string, error: unknown): IndexOpenResult {
  // A lock still standing after the busy timeout is the usual cause; say who holds it.
  const lock = LuxSqlite.describeLock(dbPath);
  return {
    ok: false,
    refusal: 'db-unreadable',
    message:
      `The Lux index at ${dbPath} could not be opened: ${errorMessage(error)}` +
      (lock ? ` (${lock})` : ''),
  };
}

/**
 * Apply the index-open policy at the DB boundary.
 *
 * Read and write-existing modes never create or migrate. They require an existing,
 * current schema. Only create-or-migrate may create a database or advance an old
 * schema, and no mode may open a schema newer than this Lux build understands.
 */
export function openIndex(dbPath: string, mode: IndexOpenMode): IndexOpenResult {
  // The schema probe is the first handle on the file, so a provably stale lock goes before it.
  reclaimStaleIndexLock(dbPath);
  const inspection = inspectExistingSchema(dbPath);
  if (inspection.status === 'unreadable') return unreadable(dbPath, inspection.message);

  if (inspection.status === 'absent' && mode !== 'create-or-migrate') {
    return {
      ok: false,
      refusal: 'index-absent',
      message: `No Lux index exists at ${dbPath}. Run \`lux index rebuild\` explicitly.`,
    };
  }

  const latest = MigrationRunner.latestVersion();
  if (inspection.status === 'present' && inspection.version > latest) {
    return {
      ok: false,
      refusal: 'schema-too-new',
      message:
        `The Lux index at ${dbPath} uses schema ${inspection.version}, newer than supported ` +
        `${latest}. Upgrade Lux before opening it.`,
    };
  }

  if (
    inspection.status === 'present' &&
    inspection.version < latest &&
    mode !== 'create-or-migrate'
  ) {
    return {
      ok: false,
      refusal: 'schema-too-old',
      message:
        `The Lux index at ${dbPath} uses schema ${inspection.version}, older than required ` +
        `${latest}. Run \`lux migrate up\` or \`lux index rebuild\` explicitly.`,
    };
  }

  let db: LuxDatabase | undefined;
  try {
    const autoMigrate = mode === 'create-or-migrate';
    db = new LuxDatabase(dbPath, autoMigrate, { readOnly: mode === 'read-existing' });
    if (!autoMigrate && mode === 'read-existing') db.initReadQueries();
    return { ok: true, db, schemaVersion: db.getAppliedSchemaVersion() };
  } catch (error) {
    // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
    try {
      db?.close();
    } catch {
      // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
      // Preserve the original open/migration failure.
    }
    return unreadable(dbPath, error);
  }
}
