import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function addRoute(db: LuxDatabase, route: string, handlerFqcn: string): void {
  const handlerId = `symbol:php:${handlerFqcn}`;
  db.upsertStructuralNode({ id: route, node_type: 'capability-surface', updated_at: 1 });
  db.upsertStructuralNode({ id: handlerId, node_type: 'symbol', updated_at: 1 });
  db.upsertStructuralEdge({
    id: `${route}->${handlerId}`,
    source_node_id: route,
    target_node_id: handlerId,
    edge_type: 'handled_by',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-overlay-kernel-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lux overlay ownership --kernel', () => {
  it('classifies against the vendored kernel index (JSON)', () => {
    // kernel worktree (git) + composer.json (Acme\Core) + a populated .lux
    const kernelDir = join(root, 'core');
    mkdirSync(kernelDir, { recursive: true });
    writeFileSync(
      join(kernelDir, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Core\\': 'src/' } } })
    );
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i', {
      cwd: kernelDir,
    });
    const kdb = new LuxDatabase(join(kernelDir, '.lux', 'lux.db'));
    addRoute(kdb, 'surface:http:GET:/k1', 'Acme\\Core\\C1'); // kernel-owned
    addRoute(kdb, 'surface:http:GET:/k2', 'App\\C2'); // client-override (implements)
    addRoute(kdb, 'surface:http:GET:/k3', 'App\\C3'); // client-gap
    kdb.close();

    // client corpus: composer.json (App), lux.yaml overlay.kernel, vendor symlink, populated .lux
    const client = join(root, 'client');
    mkdirSync(join(client, 'vendor', 'acme'), { recursive: true });
    writeFileSync(
      join(client, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } })
    );
    writeFileSync(join(client, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    symlinkSync(kernelDir, join(client, 'vendor', 'acme', 'core'));
    const cdb = new LuxDatabase(join(client, '.lux', 'lux.db'));
    cdb.upsertStructuralNode({ id: 'symbol:php:App\\C2', node_type: 'symbol', updated_at: 1 }); // implements /k2
    addRoute(cdb, 'surface:http:GET:/c1', 'App\\Local1'); // client-local
    cdb.close();

    const res = runCli(client, ['--corpus', client, 'overlay', 'ownership', '--kernel', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as {
      kernel: { package: string };
      summary: Record<string, number>;
    };
    expect(out.kernel.package).toBe('acme/core');
    expect(out.summary).toMatchObject({
      'kernel-owned': 1,
      'client-override': 1,
      'client-gap': 1,
      'client-local': 1,
    });
  });

  it('falls back to single-index ownership when no kernel is configured', () => {
    const client = join(root, 'plain');
    mkdirSync(client, { recursive: true });
    new LuxDatabase(join(client, '.lux', 'lux.db')).close(); // empty index, no overlay.kernel
    const res = runCli(client, ['--corpus', client, 'overlay', 'ownership']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('HTTP handler ownership');
  });

  it('stays single-index when overlay.kernel is configured but --kernel is not passed', () => {
    const client = join(root, 'configured');
    mkdirSync(client, { recursive: true });
    writeFileSync(join(client, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    new LuxDatabase(join(client, '.lux', 'lux.db')).close();
    const res = runCli(client, ['--corpus', client, 'overlay', 'ownership']); // no --kernel
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('HTTP handler ownership');
    expect(res.stdout).not.toContain('Cross-area');
  });
});
