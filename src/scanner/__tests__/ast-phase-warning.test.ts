// A failed AST symbol phase is reported with the phase named, whatever raised the error (issue #6).
// The chunked write names the phase in its own message; a failure from anywhere else in the phase
// (grammar loading, building anchor texts) does not, so the overlay names it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';

const fault = vi.hoisted(() => ({ message: '' }));

vi.mock('../ast/materialize.js', () => ({
  materializeAstSymbols: vi.fn(() => Promise.reject(new Error(fault.message))),
}));

const { rebuildWithOverlay } = await import('../rebuild-orchestrator.js');

const roots: string[] = [];

async function rebuildWarnings(message: string): Promise<string[]> {
  fault.message = message;
  const repo = mkdtempSync(join(tmpdir(), 'lux-ast-phase-'));
  roots.push(repo);
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'lux.yaml'), 'lsp:\n  enabled: false\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  const db = new LuxDatabase(join(repo, 'lux.db'));
  try {
    return (await rebuildWithOverlay(db, repo, { vendorPackPath: null })).result.warnings;
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('AST symbol phase failure warning', () => {
  it('names the phase when the error does not', async () => {
    const warnings = await rebuildWarnings('tree-sitter grammar failed to load');
    expect(warnings).toContain(
      'AST symbol materialization failed — tree-sitter grammar failed to load'
    );
  });

  it('does not repeat the phase when the chunked write already named it', async () => {
    const chunked = 'AST symbol materialization stopped after 3 of 9 symbol nodes: disk full';
    const warnings = await rebuildWarnings(chunked);
    expect(warnings).toContain(chunked);
    expect(warnings.join('\n')).not.toContain('AST symbol materialization failed — AST symbol');
  });
});
