import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

type ProcessEnvironment = Record<string, string | undefined>;
import type { IndexStatusPayload } from '../status-payload.js';
import type { LuxDatabase } from '../../db/index.js';
import type { IndexOpenRefusal } from '../../db/open-policy.js';

export interface DoctorCheckV1 {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'not_applicable';
  message: string;
  remediation?: string;
}

/** Stable IDs form the doctor registry even when a check is not applicable. */
export const DOCTOR_CHECK_IDS = Object.freeze([
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
] as const);

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export interface DoctorCheckContext {
  corpusRoot: string;
  dbPath?: string;
  payload?: IndexStatusPayload;
  db?: LuxDatabase;
  indexRefusal?: IndexOpenRefusal;
  env?: ProcessEnvironment;
  /** Pure test seam; production uses PATH lookup only and never installs anything. */
  commandExists?: (command: string, env: ProcessEnvironment) => boolean;
  /** Pure test seam for tracked/ignored questions. */
  gitQuery?: (args: readonly string[], corpusRoot: string) => boolean | null;
  /** Optional Phase-5 manifest preflight result. */
  corpusManifestDrift?: string | null;
  /** Optional dependency diagnostics supplied by adapters as they land. */
  missingParserDependencies?: readonly string[];
  /** Optional model identity; when absent embedding coverage is not applicable. */
  embeddingModel?: string;
}

export type DoctorCheckRunner = (context: DoctorCheckContext) => DoctorCheckV1;

function check(
  id: DoctorCheckId,
  status: DoctorCheckV1['status'],
  message: string,
  remediation?: string
): DoctorCheckV1 {
  return { id, status, message, ...(remediation ? { remediation } : {}) };
}

function defaultCommandExists(command: string, env: ProcessEnvironment): boolean {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
      return false;
    }
  }
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
      // Continue checking PATH. No subprocess and no mutation are needed.
    }
  }
  return false;
}

function defaultGitQuery(args: readonly string[], corpusRoot: string): boolean | null {
  try {
    execFileSync('git', [...args], {
      cwd: corpusRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return true;
  } catch (error) {
    // lux-intentional-swallow: git exits 1 for a clean answer and otherwise the check reports the unknown (null) result.
    const status = (error as { status?: number }).status;
    return status === 1 ? false : null;
  }
}

function readConfig(corpusRoot: string): { value?: Record<string, unknown>; error?: string } {
  const path = join(corpusRoot, 'lux.yaml');
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown> };
    }
    return { error: 'lux.yaml root is not a mapping' };
  } catch (error) {
    // lux-intentional-swallow: the parse error is returned and doctor reports it as a failed check.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function strings(value: unknown, key = ''): Array<{ key: string; value: string }> {
  if (typeof value === 'string') return [{ key, value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) => strings(item, `${key}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    strings(child, key ? `${key}.${childKey}` : childKey)
  );
}

function configuredLspCommands(config: Record<string, unknown> | undefined): string[] {
  const lsp = config?.lsp;
  if (!lsp || typeof lsp !== 'object' || Array.isArray(lsp)) return [];
  if ((lsp as { enabled?: unknown }).enabled !== true) return [];
  const enrichers = (lsp as { enrichers?: unknown }).enrichers;
  if (!Array.isArray(enrichers)) return [];
  return enrichers
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry)
    )
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.server_command)
    .filter((command): command is string => typeof command === 'string' && command.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function configMissing(context: DoctorCheckContext): DoctorCheckV1 {
  return existsSync(join(context.corpusRoot, 'lux.yaml'))
    ? check('doctor.config.missing', 'pass', 'Portable Lux configuration exists.')
    : check(
        'doctor.config.missing',
        'fail',
        'lux.yaml is absent.',
        'Run `lux init` to preview portable configuration.'
      );
}

function missingLspCommand(context: DoctorCheckContext): DoctorCheckV1 {
  const aggregate = lspBinaries(context);
  return check(
    'doctor.lsp.command-missing',
    aggregate.status,
    aggregate.message,
    aggregate.remediation
  );
}

function trackedDatabase(context: DoctorCheckContext): DoctorCheckV1 {
  const aggregate = indexTracking(context);
  return check(
    'doctor.database.tracked',
    aggregate.status,
    aggregate.message,
    aggregate.remediation
  );
}

function languagePartial(
  context: DoctorCheckContext,
  id: Extract<DoctorCheckId, `doctor.language.${string}-partial`>,
  languageId: string
): DoctorCheckV1 {
  const language = context.payload?.coverage.languages.find(
    (candidate) => candidate.languageId === languageId
  );
  if (!language || language.files === 0) {
    return check(id, 'not_applicable', `No ${languageId} files are indexed.`);
  }
  const gaps = Object.entries(language.capabilities)
    .filter(
      ([, capability]) => capability.state !== 'active' && capability.state !== 'not_applicable'
    )
    .map(([name, capability]) => `${name}:${capability.state}`);
  return gaps.length > 0
    ? check(id, 'warn', `${languageId} capability gaps: ${gaps.join(', ')}.`)
    : check(id, 'pass', `${languageId} capability coverage is active.`);
}

function javascriptPartial(context: DoctorCheckContext): DoctorCheckV1 {
  return languagePartial(context, 'doctor.language.javascript-partial', 'javascript');
}

function vuePartial(context: DoctorCheckContext): DoctorCheckV1 {
  return languagePartial(context, 'doctor.language.vue-partial', 'vue');
}

function indexPresence(context: DoctorCheckContext): DoctorCheckV1 {
  if (context.indexRefusal === 'index-absent' || !context.dbPath || !existsSync(context.dbPath)) {
    return check(
      'index.presence',
      'fail',
      'Lux index is absent.',
      'Run `lux index rebuild` explicitly.'
    );
  }
  if (context.indexRefusal === 'db-unreadable') {
    return check(
      'index.presence',
      'fail',
      'Lux index is unreadable.',
      'Repair or rebuild the index.'
    );
  }
  return check('index.presence', 'pass', 'Lux index exists and is readable.');
}

function indexSchema(context: DoctorCheckContext): DoctorCheckV1 {
  if (context.indexRefusal === 'schema-too-old' || context.indexRefusal === 'schema-too-new') {
    return check(
      'index.schema',
      'fail',
      `Lux index schema is incompatible (${context.indexRefusal}).`,
      context.indexRefusal === 'schema-too-old'
        ? 'Run `lux migrate up` or rebuild explicitly.'
        : 'Upgrade Lux before opening this index.'
    );
  }
  if (!context.payload)
    return check('index.schema', 'not_applicable', 'No readable index to inspect.');
  return check('index.schema', 'pass', 'Lux index schema is compatible.');
}

function indexStaleness(context: DoctorCheckContext): DoctorCheckV1 {
  const freshness = context.payload?.freshness;
  if (!freshness)
    return check('index.staleness', 'not_applicable', 'Index freshness is unavailable.');
  if (freshness.assessment !== 'clean') {
    return check(
      'index.staleness',
      'warn',
      `Index freshness is ${freshness.assessment}.`,
      'Run `lux index sync` explicitly.'
    );
  }
  return check('index.staleness', 'pass', 'Index is fresh.');
}

function indexTracking(context: DoctorCheckContext): DoctorCheckV1 {
  const query = context.gitQuery ?? defaultGitQuery;
  const tracked = query(['ls-files', '--error-unmatch', '--', '.lux/lux.db'], context.corpusRoot);
  if (tracked === null)
    return check('index.tracking', 'not_applicable', 'Git tracking state is unavailable.');
  if (tracked) {
    return check(
      'index.tracking',
      'fail',
      '.lux/lux.db is tracked by Git.',
      'Remove it from the index and keep `.lux/` ignored.'
    );
  }
  return check('index.tracking', 'pass', '.lux/lux.db is not tracked.');
}

function indexIgnore(context: DoctorCheckContext): DoctorCheckV1 {
  const query = context.gitQuery ?? defaultGitQuery;
  const ignored = query(['check-ignore', '-q', '--', '.lux/lux.db'], context.corpusRoot);
  if (ignored === null)
    return check('index.ignore', 'not_applicable', 'Git ignore state is unavailable.');
  if (!ignored) {
    return check(
      'index.ignore',
      'warn',
      '.lux/lux.db is not ignored by Git.',
      'Add `.lux/` to .gitignore.'
    );
  }
  return check('index.ignore', 'pass', '.lux/lux.db is ignored.');
}

function pathIsAbsolute(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('\\\\');
}

function absoluteConfigPaths(context: DoctorCheckContext): DoctorCheckV1 {
  const config = readConfig(context.corpusRoot);
  if (config.error)
    return check('config.absolute-paths', 'fail', `Cannot inspect lux.yaml: ${config.error}.`);
  if (!config.value) return check('config.absolute-paths', 'not_applicable', 'lux.yaml is absent.');
  const offenders = strings(config.value)
    .filter(
      ({ key, value }) => /(path|root|command|db|database)$/iu.test(key) && pathIsAbsolute(value)
    )
    .map(({ key }) => key);
  if (offenders.length > 0) {
    return check(
      'config.absolute-paths',
      'fail',
      `lux.yaml contains absolute path values: ${offenders.join(', ')}.`,
      'Use checkout-relative paths and PATH-resolved command names.'
    );
  }
  return check('config.absolute-paths', 'pass', 'lux.yaml contains no absolute path values.');
}

function lspBinaries(context: DoctorCheckContext): DoctorCheckV1 {
  const config = readConfig(context.corpusRoot);
  if (!config.value)
    return check('lsp.binaries', 'not_applicable', 'No configured optional LSP binaries.');
  const commands = configuredLspCommands(config.value);
  if (commands.length === 0)
    return check('lsp.binaries', 'not_applicable', 'No enabled optional LSP binaries.');
  const env: ProcessEnvironment = context.env ?? process.env;
  const commandExists = context.commandExists ?? defaultCommandExists;
  const missing = commands.filter((command) => !commandExists(command, env));
  if (missing.length > 0) {
    return check(
      'lsp.binaries',
      'warn',
      `Optional LSP binaries are missing: ${missing.join(', ')}.`,
      'Install them with your preferred package manager, or disable their enrichers.'
    );
  }
  return check('lsp.binaries', 'pass', 'Configured optional LSP binaries are available.');
}

function coverageLanguages(context: DoctorCheckContext): DoctorCheckV1 {
  const languages = context.payload?.coverage.languages;
  if (!languages)
    return check('coverage.languages', 'not_applicable', 'Language coverage is unavailable.');
  const faults = languages.flatMap((language) =>
    Object.entries(language.capabilities)
      .filter(([, capability]) => ['partial', 'failed', 'unsupported'].includes(capability.state))
      .map(([capability, evidence]) => `${language.languageId}/${capability}:${evidence.state}`)
  );
  if (faults.length > 0) {
    return check(
      'coverage.languages',
      'warn',
      `Language capability gaps: ${faults.sort().join(', ')}.`,
      'Review producer configuration and failures; unsupported states are diagnostic, not installer actions.'
    );
  }
  return check('coverage.languages', 'pass', 'Language capability coverage has no reported gaps.');
}

function parserDependencies(context: DoctorCheckContext): DoctorCheckV1 {
  const missing = [...(context.missingParserDependencies ?? [])].sort();
  if (missing.length === 0) {
    return check('parser.dependencies', 'pass', 'No missing parser dependencies were reported.');
  }
  return check(
    'parser.dependencies',
    'fail',
    `Parser dependencies are missing: ${missing.join(', ')}.`,
    'Install the matching Lux distribution dependencies; doctor will not install them.'
  );
}

function manifestDrift(context: DoctorCheckContext): DoctorCheckV1 {
  if (context.corpusManifestDrift === undefined) {
    return check('corpus.manifest-drift', 'not_applicable', 'No corpus manifest was supplied.');
  }
  if (context.corpusManifestDrift) {
    return check(
      'corpus.manifest-drift',
      'fail',
      `Corpus manifest drift: ${context.corpusManifestDrift}.`,
      'Use the pinned remote and commit in an isolated worktree.'
    );
  }
  return check('corpus.manifest-drift', 'pass', 'Corpus matches its manifest.');
}

function embeddingCoverage(context: DoctorCheckContext): DoctorCheckV1 {
  if (!context.db || !context.embeddingModel) {
    return check('embedding.coverage', 'not_applicable', 'Embedding coverage was not requested.');
  }
  const coverage = context.db.getAnchorEmbeddingCoverage(context.embeddingModel);
  if (coverage.anchorViableNodes > coverage.embeddedNodes) {
    return check(
      'embedding.coverage',
      'warn',
      `Embedding coverage is ${coverage.embeddedNodes}/${coverage.anchorViableNodes}.`,
      'Run the explicit embedding rebuild flow if semantic anchors are desired.'
    );
  }
  return check(
    'embedding.coverage',
    'pass',
    `Embedding coverage is ${coverage.embeddedNodes}/${coverage.anchorViableNodes}.`
  );
}

function hookState(context: DoctorCheckContext): DoctorCheckV1 {
  const dotGit = join(context.corpusRoot, '.git');
  if (!existsSync(dotGit) || !lstatSync(dotGit).isDirectory()) {
    return check('hook.state', 'not_applicable', 'Git hook state is unavailable.');
  }
  const hook = join(dotGit, 'hooks', 'post-commit');
  if (!existsSync(hook)) {
    return check(
      'hook.state',
      'warn',
      'Lux post-commit hook is not installed.',
      'Optionally run `lux hooks install` separately.'
    );
  }
  const content = readFileSync(hook, 'utf8');
  if (!content.includes('Lux - Git post-commit hook')) {
    return check('hook.state', 'warn', 'A non-Lux post-commit hook is installed.');
  }
  return check('hook.state', 'pass', 'Lux post-commit hook is installed.');
}

function rootPermissions(context: DoctorCheckContext): DoctorCheckV1 {
  try {
    const canonical = realpathSync(resolve(context.corpusRoot));
    accessSync(canonical, constants.R_OK | constants.W_OK);
    return check('root.permissions', 'pass', 'Corpus root is readable and writable.');
  } catch {
    // lux-intentional-swallow: doctor reports this as a failed check.
    return check(
      'root.permissions',
      'fail',
      'Corpus root is not readable and writable.',
      'Correct filesystem ownership or permissions.'
    );
  }
}

export const DOCTOR_CHECK_REGISTRY: Readonly<Record<DoctorCheckId, DoctorCheckRunner>> =
  Object.freeze({
    'doctor.config.missing': configMissing,
    'doctor.lsp.command-missing': missingLspCommand,
    'doctor.database.tracked': trackedDatabase,
    'doctor.language.javascript-partial': javascriptPartial,
    'doctor.language.vue-partial': vuePartial,
    'index.presence': indexPresence,
    'index.schema': indexSchema,
    'index.staleness': indexStaleness,
    'index.tracking': indexTracking,
    'index.ignore': indexIgnore,
    'config.absolute-paths': absoluteConfigPaths,
    'lsp.binaries': lspBinaries,
    'coverage.languages': coverageLanguages,
    'parser.dependencies': parserDependencies,
    'corpus.manifest-drift': manifestDrift,
    'embedding.coverage': embeddingCoverage,
    'hook.state': hookState,
    'root.permissions': rootPermissions,
  });

/** Run every registered diagnostic in stable ID order. Checks never write or install. */
export function runDoctorChecks(context: DoctorCheckContext): DoctorCheckV1[] {
  return DOCTOR_CHECK_IDS.map((id) => DOCTOR_CHECK_REGISTRY[id](context));
}
