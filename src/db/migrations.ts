import type { LuxSqlite } from './sqlite-adapter.js';
import { writeInChunks } from './chunked-writes.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { dbNotice } from './notices.js';
import { layoutPath } from '../utils/package-layout.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  applied_at: number;
}

/**
 * Migration manager for the Lux database.
 * Handles schema versioning and migrations.
 */
export class MigrationRunner {
  private db: LuxSqlite;
  private migrationsPath: string;

  constructor(db: LuxSqlite) {
    this.db = db;
    this.migrationsPath = layoutPath('db/migrations');
    this.initMigrationsTable();
  }

  /**
   * Initialize the schema_version table if it doesn't exist.
   */
  private initMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }

  /**
   * Get the current schema version from the database.
   */
  getCurrentVersion(): number {
    // transient one-shot read → adapter's auto-finalizing `get` (not a registry-tracked prepare)
    const result = this.db.get('SELECT MAX(version) as version FROM schema_version') as {
      version: number | null;
    };
    return result.version ?? 0;
  }

  /**
   * Get all applied migrations from the database.
   */
  getAppliedMigrations(): AppliedMigration[] {
    return this.db.all(
      'SELECT version, applied_at FROM schema_version ORDER BY version'
    ) as AppliedMigration[];
  }

  /**
   * Load all migration files from the migrations directory.
   */
  loadMigrations(): Migration[] {
    const files = readdirSync(this.migrationsPath)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    return files.map((file) => {
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename: ${file}`);
      }

      const version = parseInt(match[1], 10);
      const name = match[2];
      const sql = readFileSync(join(this.migrationsPath, file), 'utf-8');

      return { version, name, sql };
    });
  }

  /**
   * Highest packaged migration version without opening a database.
   * Read-open policy uses this to reject schema skew before any writable handle exists.
   */
  static latestVersion(): number {
    const migrationsPath = layoutPath('db/migrations');
    const versions = readdirSync(migrationsPath)
      .map((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);

    return versions.length === 0 ? 0 : Math.max(...versions);
  }

  /**
   * Get pending migrations that haven't been applied yet.
   */
  getPendingMigrations(): Migration[] {
    const currentVersion = this.getCurrentVersion();
    const allMigrations = this.loadMigrations();
    return allMigrations.filter((m) => m.version > currentVersion);
  }

  /**
   * Apply a single migration to the database.
   */
  private applyMigration(migration: Migration) {
    const applyTransaction = this.db.transaction(() => {
      // Execute the migration SQL
      this.db.exec(migration.sql);

      // Record the migration (transient one-shot write → auto-finalizing `run`)
      this.db.run('INSERT INTO schema_version (version) VALUES (?)', migration.version);
    });

    applyTransaction();
  }

  /**
   * A migration that discards data says so, but only to someone who had data to lose. Its file
   * carries `-- lux-notice-if-rows(<table>): <message>`; the message is returned when that table
   * holds rows before the migration runs, and nothing is returned on a new, empty database.
   */
  private noticeFor(migration: Migration): string | undefined {
    const header = /^-- lux-notice-if-rows\((\w+)\): (.+)$/m.exec(migration.sql);
    if (!header) return undefined;
    const [, table, message] = header;
    const exists = this.db.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      table
    );
    if (!exists) return undefined;
    const row = this.db.get(`SELECT EXISTS (SELECT 1 FROM ${table}) AS any_rows`) as {
      any_rows: number;
    };
    return row.any_rows ? message.trim() : undefined;
  }

  /**
   * Run all pending migrations.
   * Returns the number of migrations applied.
   */
  runMigrations(): number {
    const pending = this.getPendingMigrations();

    if (pending.length === 0) {
      return 0;
    }

    // One transaction for the whole run, so a fresh index commits once rather than once per
    // migration; each migration is still its own savepoint. A failing migration stops the run and
    // the ones before it stay applied — unless its error aborted the whole transaction, in which
    // case none are, and the original error is what surfaces.
    const target = {
      transaction: <T>(fn: () => T): T => this.db.transaction(fn)(),
      inTransaction: () => this.db.inTransaction(),
    };
    const notices: string[] = [];
    const result = writeInChunks(target, pending, pending.length, (migration) => {
      dbNotice('progress', `Applying migration ${migration.version}: ${migration.name}`);
      const notice = this.noticeFor(migration);
      this.applyMigration(migration);
      if (notice) notices.push(notice);
      dbNotice('progress', `Migration ${migration.version} applied`);
    });
    if (result.error) throw result.error;
    // Raised once the run has committed: a notice about a migration that was rolled back would lie.
    for (const notice of notices) dbNotice('notice', notice);

    return pending.length;
  }

  /**
   * Check if the database is up to date.
   */
  isUpToDate(): boolean {
    return this.getPendingMigrations().length === 0;
  }

  /**
   * Get migration status information.
   */
  getStatus() {
    const currentVersion = this.getCurrentVersion();
    const allMigrations = this.loadMigrations();
    const pending = this.getPendingMigrations();
    const applied = this.getAppliedMigrations();

    return {
      currentVersion,
      latestVersion: allMigrations[allMigrations.length - 1]?.version ?? 0,
      appliedCount: applied.length,
      pendingCount: pending.length,
      isUpToDate: pending.length === 0,
      appliedMigrations: applied,
      pendingMigrations: pending.map((m) => ({
        version: m.version,
        name: m.name,
      })),
    };
  }
}
