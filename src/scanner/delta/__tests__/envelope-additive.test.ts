// Envelope stability — crossRepoImpact is STRICTLY additive (spec 14 / T3.3 / SC-9). Without
// --against the serialized delta envelope stays schemaVersion:1 and carries NO crossRepoImpact key
// (byte-identical to the shipped shape); with --against the key appears and the version does NOT
// bump. The serialized form (what `--json` prints) is the contract, so the assertions run over
// JSON.stringify output, not Object.keys (which lists undefined optional fields).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { computeDelta } from '../run.js';
import type { DeltaOptions } from '../types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function opts(over: Partial<DeltaOptions> = {}): DeltaOptions {
  return {
    depth: 6,
    maxNodes: 2000,
    maxFanout: 64,
    minConfidence: 'framework-inferred',
    json: true,
    ...over,
  };
}

let root: string;
let corpus: string;
let db: LuxDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-envelope-additive-'));
  corpus = join(root, 'corpus');
  mkdirSync(corpus, { recursive: true });
  git(corpus, ['init', '-q']);
  git(corpus, ['config', 'user.email', 'test@example.com']);
  git(corpus, ['config', 'user.name', 'Test']);
  git(corpus, ['config', 'commit.gpgsign', 'false']);
  git(corpus, ['commit', '-q', '--allow-empty', '-m', 'base']);
  db = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
  db.setIndexMetadata('last_indexed_commit', git(corpus, ['rev-parse', 'HEAD']));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('delta envelope — crossRepoImpact additive (SC-9)', () => {
  it('no --against: schemaVersion:1 and NO crossRepoImpact key in the serialized envelope', async () => {
    const result = await computeDelta(db, corpus, opts({ committedOnly: true }));
    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const json = JSON.stringify(result.report, null, 2); // exactly what `--json` prints
    expect(result.report.schemaVersion).toBe(1);
    expect(json).not.toContain('crossRepoImpact');
    expect(JSON.parse(json)).not.toHaveProperty('crossRepoImpact');
  });

  it('--against: crossRepoImpact appears, schemaVersion stays 1 (no bump)', async () => {
    writeFileSync(join(corpus, 'lux.yaml'), 'siblings: {}\n'); // ghost is unregistered → attached:false
    const result = await computeDelta(
      db,
      corpus,
      opts({ committedOnly: true, against: ['ghost'] })
    );
    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const json = JSON.stringify(result.report, null, 2);
    expect(result.report.schemaVersion).toBe(1);
    expect(JSON.parse(json)).toHaveProperty('crossRepoImpact');
    expect(result.report.crossRepoImpact?.siblings[0]).toMatchObject({
      name: 'ghost',
      attached: false,
    });
  });

  it('the no-against envelope is unchanged by registering (but not querying) siblings', async () => {
    // Registering a sibling changes NO behavior by itself — federation is opt-in per query.
    const sibDb = join(root, 'sib', '.lux', 'lux.db');
    new LuxDatabase(sibDb).close();
    writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  sib:\n    db: ${sibDb}\n`);
    const result = await computeDelta(db, corpus, opts({ committedOnly: true })); // no --against
    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    expect(JSON.stringify(result.report)).not.toContain('crossRepoImpact');
  });
});
