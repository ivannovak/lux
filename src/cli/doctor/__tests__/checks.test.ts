import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCTOR_CHECK_IDS,
  DOCTOR_CHECK_REGISTRY,
  runDoctorChecks,
  type DoctorCheckContext,
} from '../checks.js';
import type { IndexStatusPayload } from '../../status-payload.js';

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'lux-doctor-'));
  roots.push(value);
  return value;
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function context(corpusRoot: string): DoctorCheckContext {
  return {
    corpusRoot,
    dbPath: join(corpusRoot, '.lux', 'lux.db'),
    gitQuery: () => false,
  };
}

function payload(languages: IndexStatusPayload['coverage']['languages']): IndexStatusPayload {
  return {
    stats: {} as IndexStatusPayload['stats'],
    overlay: {} as IndexStatusPayload['overlay'],
    coverage: { languages },
    lspEnrichmentFailures: [],
    symbolIdCollisions: { collidingIds: 0, edgesToAmbiguousIds: 0, droppedAmbiguousReferences: 0 },
  };
}

describe('doctor registry', () => {
  it('covers every specified fault with stable unique IDs', () => {
    expect(new Set(DOCTOR_CHECK_IDS).size).toBe(DOCTOR_CHECK_IDS.length);
    expect(Object.keys(DOCTOR_CHECK_REGISTRY)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(DOCTOR_CHECK_IDS).toEqual(
      expect.arrayContaining([
        'doctor.config.missing',
        'doctor.lsp.command-missing',
        'doctor.database.tracked',
        'doctor.language.javascript-partial',
        'doctor.language.vue-partial',
        'index.presence',
        'index.schema',
        'index.staleness',
        'index.tracking',
        'index.ignore',
        'config.absolute-paths',
        'lsp.binaries',
        'coverage.languages',
        'parser.dependencies',
        'corpus.manifest-drift',
        'embedding.coverage',
        'hook.state',
        'root.permissions',
      ])
    );
  });

  it('rejects POSIX, Windows, and database absolute config paths on every host', () => {
    const corpus = root();
    writeFileSync(
      join(corpus, 'lux.yaml'),
      'index:\n  database: /tmp/lux.db\nlsp:\n  enabled: true\n  enrichers:\n    - server_command: C:\\\\tools\\\\server.exe\n'
    );
    const result = runDoctorChecks(context(corpus)).find(
      (item) => item.id === 'config.absolute-paths'
    );
    expect(result).toMatchObject({ status: 'fail' });
    expect(result?.message).toContain('index.database');
    expect(result?.message).toContain('lsp.enrichers[0].server_command');
  });

  it('reports missing optional LSP without installing or mutating', () => {
    const corpus = root();
    writeFileSync(
      join(corpus, 'lux.yaml'),
      [
        'lsp:',
        '  enabled: true',
        '  enrichers:',
        '    - language_id: vue',
        '      server_command: vue-language-server',
        '',
      ].join('\n')
    );
    const before = new Map([['lux.yaml', writeFileSnapshot(join(corpus, 'lux.yaml'))]]);
    const result = runDoctorChecks({
      ...context(corpus),
      commandExists: () => false,
    }).find((item) => item.id === 'lsp.binaries');
    expect(result).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('vue-language-server'),
    });
    expect(writeFileSnapshot(join(corpus, 'lux.yaml'))).toBe(before.get('lux.yaml'));
  });

  it('fails a tracked database and warns when it is unignored', () => {
    const corpus = root();
    mkdirSync(join(corpus, '.lux'));
    writeFileSync(join(corpus, '.lux', 'lux.db'), 'sentinel');
    const checks = runDoctorChecks({
      ...context(corpus),
      gitQuery: (args) => args[0] === 'ls-files',
    });
    expect(checks.find((item) => item.id === 'index.tracking')?.status).toBe('fail');
    expect(checks.find((item) => item.id === 'index.ignore')?.status).toBe('warn');
  });

  it('reports partial Vue and unsupported JavaScript coverage explicitly', () => {
    const corpus = root();
    const capability = (state: 'active' | 'partial' | 'unsupported') => ({
      state,
      producer: 'fixture',
      nodes: state === 'active' ? 1 : 0,
      edges: 0,
      failures: 0,
    });
    const capabilities = (symbols: 'partial' | 'unsupported') => ({
      syntax: capability('active'),
      symbols: capability(symbols),
      imports: capability('unsupported'),
      calls: capability('unsupported'),
      references: capability('unsupported'),
      framework: capability('active'),
    });
    const checks = runDoctorChecks({
      ...context(corpus),
      payload: payload([
        {
          schemaVersion: 1,
          languageId: 'vue',
          files: 2,
          symbolizedFiles: 1,
          symbols: 1,
          relatedSymbols: 0,
          capabilities: capabilities('partial'),
        },
        {
          schemaVersion: 1,
          languageId: 'javascript',
          files: 2,
          symbolizedFiles: 0,
          symbols: 0,
          relatedSymbols: 0,
          capabilities: capabilities('unsupported'),
        },
      ]),
    });
    const result = checks.find((item) => item.id === 'coverage.languages');
    expect(result?.status).toBe('warn');
    expect(result?.message).toContain('vue/symbols:partial');
    expect(result?.message).toContain('javascript/symbols:unsupported');
  });
});

function writeFileSnapshot(path: string): string {
  return readFileSync(path).toString('hex');
}
