// A migrated, empty index for a CLI call that would otherwise create one.
//
// A `lux` command that opens a database that does not exist creates it and runs every migration,
// about a tenth of a second of a small rebuild. Most tests rebuild into a new database and are not
// about migrating it, so they start from a copy of one migrated once per test process. A test that
// is about creating or migrating a database does not use this.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';

let template: string | undefined;

function migratedTemplate(): string {
  if (template === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'lux-index-template-'));
    // The directory is this process's own: it goes when the process does.
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'lux.db');
    new LuxDatabase(path).close();
    template = path;
  }
  return template;
}

/** Put a migrated, empty index at `dbPath` unless there is a database there already. */
export function seedIndex(dbPath: string): void {
  if (existsSync(dbPath)) return;
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(migratedTemplate(), dbPath);
}
