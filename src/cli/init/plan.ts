import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** A complete post-apply file image. Paths are always corpus-root-relative. */
export interface InitChangeV1 {
  path: string;
  action: 'create' | 'append' | 'unchanged';
  beforeHash?: string;
  content: string;
  /** Existing owner bytes differ from HEAD; generic --yes must not overwrite them. */
  dirty?: boolean;
}

/** Frozen portable-init planning contract. Planning never writes to the corpus. */
export interface InitPlanV1 {
  corpusRoot: string;
  detected: string[];
  changes: InitChangeV1[];
  diagnostics: string[];
}

export interface AtomicWriteOptions {
  /** Test seam used to model a process failure after durable temp write, before rename. */
  beforeRename?: (temporaryPath: string, targetPath: string) => void;
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.lux',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

const LANGUAGE_EXTENSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  go: new Set(['.go']),
  javascript: new Set(['.cjs', '.js', '.jsx', '.mjs']),
  php: new Set(['.php']),
  python: new Set(['.py']),
  rust: new Set(['.rs']),
  typescript: new Set(['.cts', '.mts', '.ts', '.tsx']),
  vue: new Set(['.vue']),
};

const MANIFEST_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  'Cargo.toml': ['rust'],
  'composer.json': ['php'],
  'go.mod': ['go'],
  'package.json': ['javascript'],
  'pyproject.toml': ['python'],
  'requirements.txt': ['python'],
  'tsconfig.json': ['typescript'],
};

const MODULE_LAYOUTS = [
  'app/Modules/{name}',
  'src/Modules/{name}',
  'src/Module/{name}',
  'src/modules/{name}',
  'packages/{name}',
  'apps/{name}',
] as const;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function extension(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function portableRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

/**
 * Deterministically detect source languages and conventional module boundaries.
 * Symlinks and generated/dependency trees are deliberately not traversed.
 */
function detectProjectCapabilities(corpusRoot: string): string[] {
  const root = realpathSync(resolve(corpusRoot));
  const found = new Set<string>();
  const pending = [root];

  for (const [manifest, languages] of Object.entries(MANIFEST_LANGUAGES)) {
    if (existsSync(resolve(root, manifest))) {
      for (const language of languages) found.add(`language:${language}`);
    }
  }

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extension(entry.name);
      for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
        if (extensions.has(ext)) found.add(`language:${language}`);
      }
    }
  }

  for (const layout of MODULE_LAYOUTS) {
    const directory = layout.slice(0, -'/{name}'.length);
    const absolutePath = resolve(root, directory);
    if (!existsSync(absolutePath)) continue;
    const stat = lstatSync(absolutePath);
    if (!stat.isSymbolicLink() && stat.isDirectory()) found.add(`module-layout:${layout}`);
  }

  return [...found].sort((left, right) => left.localeCompare(right));
}

function lspEntries(detected: readonly string[]): Array<{
  languageId: string;
  serverCommand: string;
}> {
  const values = new Set(detected);
  const entries: Array<{ languageId: string; serverCommand: string }> = [];
  if (values.has('language:php')) {
    entries.push({ languageId: 'php', serverCommand: 'intelephense' });
  }
  if (
    values.has('language:typescript') ||
    values.has('language:javascript') ||
    values.has('language:vue')
  ) {
    entries.push({
      languageId: 'typescript',
      serverCommand: 'typescript-language-server',
    });
  }
  if (values.has('language:vue')) {
    entries.push({ languageId: 'vue', serverCommand: 'vue-language-server' });
  }
  return entries;
}

/** Render only portable values: workspace root is relative and commands are PATH lookups. */
export function renderPortableLuxYaml(detected: readonly string[]): string {
  const enrichers = lspEntries(detected);
  const moduleLayout = detected
    .filter((value) => value.startsWith('module-layout:'))
    .map((value) => value.slice('module-layout:'.length))
    .sort((left, right) => left.localeCompare(right))[0];

  const lines = [
    '# Generated by lux init. Paths remain portable across checkouts.',
    'schema_version: 1',
    'workspace:',
    '  root: .',
    'index:',
    '  database: .lux/lux.db',
    'lsp:',
    `  enabled: ${enrichers.length > 0 ? 'true' : 'false'}`,
    '  workspace_root: .',
    '  enrichers:',
  ];
  if (enrichers.length === 0) lines.push('    []');
  for (const entry of enrichers) {
    lines.push(`    - language_id: ${entry.languageId}`);
    lines.push('      enabled: true');
    lines.push(`      server_command: ${entry.serverCommand}`);
    lines.push('      server_args:');
    lines.push('        - --stdio');
  }
  lines.push('deps:');
  lines.push('  enabled: true');
  if (moduleLayout) lines.push(`  module_boundary: ${moduleLayout}`);
  return `${lines.join('\n')}\n`;
}

function configSections(detected: readonly string[]): Record<string, string> {
  const full = renderPortableLuxYaml(detected);
  const starts = ['schema_version:', 'workspace:', 'index:', 'lsp:', 'deps:'].map((header) => ({
    key: header.slice(0, -1),
    start: full.indexOf(`${header}\n`) >= 0 ? full.indexOf(`${header}\n`) : full.indexOf(header),
  }));
  return Object.fromEntries(
    starts.map(({ key, start }, index) => [
      key,
      full.slice(start, starts[index + 1]?.start ?? full.length).trimEnd(),
    ])
  );
}

function isGitDirty(root: string, path: string): boolean {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return output.trim().length > 0;
  } catch {
    // lux-intentional-swallow: not a git checkout, or git unavailable: there is no uncommitted work to protect.
    return false;
  }
}

function rejectSymlinkTarget(absolutePath: string, portablePath: string): void {
  try {
    if (lstatSync(absolutePath).isSymbolicLink()) {
      throw new Error(`Refusing to plan a write through symlink: ${portablePath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function planConfig(
  root: string,
  detected: readonly string[],
  diagnostics: string[]
): InitChangeV1 {
  const path = 'lux.yaml';
  const absolutePath = resolve(root, path);
  const generated = renderPortableLuxYaml(detected);
  rejectSymlinkTarget(absolutePath, path);
  if (!existsSync(absolutePath)) return { path, action: 'create', content: generated };

  const before = readFileSync(absolutePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(before);
  } catch (error) {
    diagnostics.push(
      `lux.yaml was not changed because it is invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
    return { path, action: 'unchanged', beforeHash: sha256(before), content: before };
  }
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    diagnostics.push('lux.yaml was not changed because its root is not a mapping.');
    return { path, action: 'unchanged', beforeHash: sha256(before), content: before };
  }

  const mapping = (parsed ?? {}) as Record<string, unknown>;
  const sections = configSections(detected);
  const missing = ['schema_version', 'workspace', 'index', 'lsp', 'deps'].flatMap((key) =>
    Object.hasOwn(mapping, key) ? [] : [sections[key]]
  );
  if (missing.length === 0) {
    return { path, action: 'unchanged', beforeHash: sha256(before), content: before };
  }

  const separator = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const content = `${before}${separator}${before.length > 0 ? '\n' : ''}${missing.join('\n')}\n`;
  const dirty = isGitDirty(root, path);
  diagnostics.push(
    dirty
      ? 'lux.yaml has uncommitted owner changes; generic --yes will not overwrite it.'
      : 'lux.yaml has existing content; applying this append requires confirmation.'
  );
  return {
    path,
    action: 'append',
    beforeHash: sha256(before),
    content,
    ...(dirty ? { dirty } : {}),
  };
}

function planGitignore(root: string, diagnostics: string[]): InitChangeV1 {
  const path = '.gitignore';
  const absolutePath = resolve(root, path);
  rejectSymlinkTarget(absolutePath, path);
  if (!existsSync(absolutePath)) return { path, action: 'create', content: '.lux/\n' };

  const before = readFileSync(absolutePath, 'utf8');
  if (before.split(/\r?\n/u).some((line) => line.trim() === '.lux/')) {
    return { path, action: 'unchanged', beforeHash: sha256(before), content: before };
  }
  const separator = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const dirty = isGitDirty(root, path);
  diagnostics.push(
    dirty
      ? '.gitignore has uncommitted owner changes; generic --yes will not overwrite it.'
      : '.gitignore has existing content; applying this append requires confirmation.'
  );
  return {
    path,
    action: 'append',
    beforeHash: sha256(before),
    content: `${before}${separator}.lux/\n`,
    ...(dirty ? { dirty } : {}),
  };
}

/** Build a side-effect-free, stable-order initialization plan. */
export function buildInitPlan(corpusRoot: string): InitPlanV1 {
  const root = realpathSync(resolve(corpusRoot));
  const diagnostics: string[] = [];
  const detected = detectProjectCapabilities(root);
  if (detected.length === 0)
    diagnostics.push('No supported language or module layout was detected.');
  diagnostics.push(
    'Git hooks are not part of init; optionally run `lux hooks install` separately.'
  );
  return {
    corpusRoot: root,
    detected,
    changes: [planConfig(root, detected, diagnostics), planGitignore(root, diagnostics)],
    diagnostics,
  };
}

function confinedTarget(root: string, requestedPath: string): { root: string; target: string } {
  if (!requestedPath || isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw new Error(`Init target must be a relative path: ${requestedPath}`);
  }
  const canonicalRoot = realpathSync(resolve(root));
  const target = resolve(canonicalRoot, requestedPath);
  const rel = relative(canonicalRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Init target escapes corpus root: ${requestedPath}`);
  }

  const segments = rel.split(sep).filter(Boolean);
  let cursor = canonicalRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(
        `Refusing to write through symlink: ${portableRelative(canonicalRoot, cursor)}`
      );
    }
  }
  return { root: canonicalRoot, target };
}

/**
 * Replace one file atomically after confinement, symlink, and optimistic-hash checks.
 * The temporary file is fsynced and always removed when rename is interrupted.
 */
export function writeAtomicallyInsideRoot(
  corpusRoot: string,
  path: string,
  content: string,
  beforeHash?: string,
  options: AtomicWriteOptions = {}
): void {
  const confined = confinedTarget(corpusRoot, path);
  const parentRel = relative(confined.root, resolve(confined.target, '..'));
  if (parentRel && parentRel !== '.')
    mkdirSync(resolve(confined.target, '..'), { recursive: true });

  const exists = existsSync(confined.target);
  if (beforeHash === undefined && exists) {
    throw new Error(`Refusing to overwrite existing ${path} without a beforeHash`);
  }
  if (beforeHash !== undefined) {
    if (!exists) throw new Error(`Init target changed since preview: ${path} was removed`);
    const actualHash = sha256(readFileSync(confined.target, 'utf8'));
    if (actualHash !== beforeHash) {
      throw new Error(`Init target changed since preview: ${path} hash mismatch`);
    }
  }

  const parent = resolve(confined.target, '..');
  const rootIdentity = statSync(confined.root);
  const parentIdentity = statSync(parent);
  const temporaryPath = resolve(
    confined.target,
    `../.${path.split('/').at(-1)!}.lux-init-${process.pid}-${randomUUID()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.beforeRename?.(temporaryPath, confined.target);
    // Revalidate confinement and owner bytes immediately before commit. This detects corpus/parent
    // replacement, symlink swaps, and a target modified after preview or staging.
    const rechecked = confinedTarget(corpusRoot, path);
    const rootNow = statSync(rechecked.root);
    const parentNow = statSync(resolve(rechecked.target, '..'));
    if (
      rootNow.dev !== rootIdentity.dev ||
      rootNow.ino !== rootIdentity.ino ||
      parentNow.dev !== parentIdentity.dev ||
      parentNow.ino !== parentIdentity.ino
    ) {
      throw new Error(`Init target parent changed since preview: ${path}`);
    }
    if (existsSync(rechecked.target) && lstatSync(rechecked.target).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlink: ${path}`);
    }
    if (beforeHash !== undefined) {
      if (!existsSync(rechecked.target)) {
        throw new Error(`Init target changed since preview: ${path} was removed`);
      }
      const currentHash = sha256(readFileSync(rechecked.target, 'utf8'));
      if (currentHash !== beforeHash) {
        throw new Error(`Init target changed since preview: ${path} hash mismatch`);
      }
    } else if (existsSync(rechecked.target)) {
      throw new Error(`Init target changed since preview: ${path} was created`);
    }
    renameSync(temporaryPath, rechecked.target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
      // Successful rename and failed-before-create both leave no temp file to remove.
    }
  }
}

/** Apply is an explicit seam: false is guaranteed to perform no writes. */
export function applyInitPlan(
  plan: InitPlanV1,
  confirmed: boolean,
  options: AtomicWriteOptions = {},
  rollbackOptions: AtomicWriteOptions = {}
): void {
  if (!confirmed) return;
  const pending = plan.changes.filter((change) => change.action !== 'unchanged');
  const dirty = pending.find((change) => change.dirty);
  if (dirty) throw new Error(`Refusing to overwrite dirty init target: ${dirty.path}`);

  // Validate the whole change set before committing its first member. Retain exact owner bytes so
  // a later commit failure can restore earlier members rather than exposing a partial init.
  const originals = new Map<string, string | null>();
  for (const change of pending) {
    const { target } = confinedTarget(plan.corpusRoot, change.path);
    const exists = existsSync(target);
    const original = exists ? readFileSync(target, 'utf8') : null;
    if (change.beforeHash === undefined && exists) {
      throw new Error(`Refusing to overwrite existing ${change.path} without a beforeHash`);
    }
    if (change.beforeHash !== undefined && sha256(original ?? '') !== change.beforeHash) {
      throw new Error(`Init target changed since preview: ${change.path} hash mismatch`);
    }
    originals.set(change.path, original);
  }

  const committed: InitChangeV1[] = [];
  try {
    for (const change of pending) {
      writeAtomicallyInsideRoot(
        plan.corpusRoot,
        change.path,
        change.content,
        change.beforeHash,
        options
      );
      committed.push(change);
    }
  } catch (error) {
    // Roll back only bytes this invocation can still prove it wrote. Never overwrite a concurrent
    // owner edit during recovery. Reverse order mirrors the commit order.
    for (const change of committed.reverse()) {
      const { target } = confinedTarget(plan.corpusRoot, change.path);
      if (!existsSync(target) || lstatSync(target).isSymbolicLink()) continue;
      if (sha256(readFileSync(target, 'utf8')) !== sha256(change.content)) continue;
      const original = originals.get(change.path);
      if (original === null) unlinkSync(target);
      else if (original !== undefined) {
        writeAtomicallyInsideRoot(
          plan.corpusRoot,
          change.path,
          original,
          sha256(change.content),
          rollbackOptions
        );
      }
    }
    throw error;
  }
}
