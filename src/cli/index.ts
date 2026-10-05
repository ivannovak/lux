#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync } from 'fs';
import { LuxDatabase } from '../db/index.js';
import { LuxSqlite } from '../db/sqlite-adapter.js';
import { GeneralScanner } from '../scanner/index.js';
import { attachEnrichment } from '../scanner/general.js';
import { rebuildWithOverlay, rebuildContentOnly } from '../scanner/rebuild-orchestrator.js';
import type { RebuildResult } from '../scanner/rebuild-orchestrator.js';
import {
  describeOverlayTrustInspection,
  deriveOverlayTrustLevel,
  deriveOverlayTrustLevelFromMode,
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
  persistRebuildTrustState,
  persistRefreshTrustState,
  markOverlayTrustAfterSync,
} from '../scanner/overlay-trust-state.js';
import { refreshOverlayScoped } from '../scanner/associations/overlay-refresh.js';
import type { ChangedFile } from '../scanner/associations/overlay-refresh.js';
import { loadLspConfig } from '../scanner/config.js';
import { decideScopedEligibility, decideForcedScoped } from '../scanner/sync-escalation.js';
import type { ScopedDecision } from '../scanner/sync-escalation.js';
import { persistStructuralConfigFingerprint } from '../scanner/config-fingerprint.js';
import { buildIndexStatusPayload } from './status-payload.js';
import {
  persistCoverageProducerRuns,
  persistScopedCoverageProducerRuns,
} from '../scanner/coverage/producer-runs.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import {
  isGitRepository,
  getHeadCommit,
  getGitDiff,
  commitExists,
  findLikelyNestedGitRoot,
} from '../scanner/git.js';
import {
  buildIncrementalPlan,
  collectOverlayRelevantPaths,
  commitIncrementalSync,
  hasOverlayRelevantChanges,
} from '../scanner/incremental.js';
import { assessWorkingTreeFreshness, renderFreshnessText } from '../scanner/freshness.js';
import { addSearchCommand } from './search.js';
import { registerAnchorsCommand } from './anchors.js';
import { addHooksCommand } from './hooks.js';
import { addMigrateCommands } from './migrate.js';
import { addDepsCommand } from './deps.js';
import { addVendorPackCommands } from './pack.js';
import { addTraceCommand } from './trace.js';
import { addOverlayCommands } from './overlay.js';
import { addUsageCommands } from './usage.js';
import { addDeltaCommand } from './delta.js';
import { addSiblingsCommand } from './siblings.js';
import { registerDoctorCommand } from './doctor.js';
import { registerInitCommand } from './init/index.js';
import {
  createInvocationId,
  emitUsageEvent,
  safeUsageTrustState,
} from '../db/observability/usage-event.js';
import { resolveRuntimePaths } from '../utils/runtime-paths.js';
import { LUX_VERSION } from '../utils/version.js';
import {
  runNodeEmbedPass,
  type NodeEmbedPassResult,
} from '../scanner/embeddings/node-embed-pass.js';
import { createEmbedder } from '../scanner/embeddings/embedder.js';
import type { Embedder, EmbeddingConfig } from '../scanner/embeddings/embedder.js';
import { ensureModelWeights } from '../scanner/embeddings/model-cache.js';
import {
  activeEmbeddingModel,
  embeddingReadAvailable,
} from '../scanner/embeddings/active-model.js';

const program = new Command();

interface ProgressReporter {
  start: (label: string) => void;
  log: (message: string) => void;
  finish: (label: string) => void;
}

program
  .name('lux')
  .description('Lux — structural code-analysis and overlay engine for CORPUS-indexed repositories')
  .version(LUX_VERSION)
  .option('--db <path>', 'Database path (defaults to <corpus>/.lux/lux.db)')
  .option('--corpus <path>', 'Content root directory path (defaults to current working directory)');

// Index commands
const indexCmd = program.command('index').description('Manage index');

function getRuntimePaths(cmd: Command): ReturnType<typeof resolveRuntimePaths> {
  const opts = cmd.opts();
  return resolveRuntimePaths({
    corpus: opts.corpus as string | undefined,
    db: opts.db as string | undefined,
  });
}

indexCmd
  .command('rebuild')
  .description(
    'Rebuild index from content directory.\n' +
      '  Default: overlay-complete rebuild with structural overlay and trust summary.\n' +
      '  Use --content-only for a faster fallback that skips overlay materialization.'
  )
  .option('--quiet', 'Reduce output to phase progress and final status')
  .option(
    '--content-only',
    'Run a content-only rebuild: knowledge index only, no structural overlay.'
  )
  .option(
    '--embeddings',
    'Fetch the anchor embedding model (~34 MB, one-time) and embed anchor nodes. ' +
      'Without this flag, rebuild/sync embed only when the model is already cached (never fetch).'
  )
  .action(async (options: { quiet?: boolean; contentOnly?: boolean; embeddings?: boolean }) => {
    const { corpusPath, dbPath } = getRuntimePaths(program);
    const invocationId = createInvocationId();
    const startedAt = Date.now();
    let db: LuxDatabase | undefined;

    try {
      // Validate content directory
      if (!existsSync(corpusPath)) {
        console.error(`Error: Content directory not found: ${corpusPath}`);
        console.error('  Please ensure the directory exists or set --corpus <path>');
        process.exit(1);
      }

      // A prior run killed mid-write (Ctrl-C / OOM) can leave a stale WASM-SQLite lock
      // that wedges every open; a deliberate rebuild reclaims it when no live owner remains.
      if (LuxSqlite.reclaimStaleLock(dbPath) && options.quiet !== true) {
        console.error('Note: cleared a stale database lock from a previously interrupted run.');
      }

      // Initialize database with error handling
      try {
        db = new LuxDatabase(dbPath);
      } catch (error) {
        console.error(`Error: Failed to initialize database: ${dbPath}`);
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }

      // Verify database schema is up to date
      if (!db.isSchemaUpToDate()) {
        console.error('Error: Database schema is not up to date');
        console.error('  Run "lux migrate" to update the schema');
        db.close();
        process.exit(1);
      }

      const scanner = new GeneralScanner(corpusPath);
      const progress = createProgressReporter(options.quiet === true);

      progress.start(
        `index rebuild (${options.contentOnly ? 'content-only' : 'overlay-complete'})`
      );
      progress.log(`Scanning content directory: ${corpusPath}`);

      let generalResult;
      let overlayResult: RebuildResult | undefined;
      let headCommitForTrustState: string | undefined;

      if (options.contentOnly) {
        // Content-only path: scan + enrich, no structural overlay
        try {
          const { scanResult } = await rebuildContentOnly(corpusPath, {
            db,
            onProgress: (msg) => progress.log(msg),
          });
          generalResult = scanResult;
        } catch (error) {
          console.error('Error: Failed to scan content directory');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
      } else {
        // Overlay-complete path: default rebuild mode
        try {
          const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
            onProgress: (msg) => progress.log(msg),
          });
          overlayResult = result;
          generalResult = scanResult;
        } catch (error) {
          console.error('Error: Failed to run overlay-complete rebuild');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
      }

      // Attach enrichment data to each knowledge entry
      const result = {
        ...generalResult.scan,
        knowledge: generalResult.scan.knowledge.map((entry) =>
          attachEnrichment(entry, generalResult.enrichments)
        ),
      };

      // Validate scan results
      if (!result || typeof result !== 'object') {
        console.error('Error: Invalid scan result');
        db.close();
        process.exit(1);
      }

      if (!options.quiet) {
        const sourceCodeCount = result.knowledge.filter((k) => k.type === 'source-code').length;
        const knowledgeCount = result.knowledge.length - sourceCodeCount;
        console.log(`Found:`);
        console.log(`  - ${knowledgeCount} knowledge entries`);
        console.log(`  - ${sourceCodeCount} source code files`);
        if (generalResult.stats.enrichedFiles > 0) {
          console.log(`  Enriched ${generalResult.stats.enrichedFiles} files via LSP`);
        }
        if (generalResult.dependencies.length > 0) {
          console.log(`  Detected ${generalResult.dependencies.length} module dependencies`);
        }
      }
      // Explicit embeddings opt-in (--embeddings): fetch + hash-verify the bge model weights ONCE here,
      // BEFORE the embed tail below, so the tail's cached-only presence check finds them and embeds.
      // Default (no flag): rebuild/sync stay cached-only — the tail embeds iff the weights are already
      // present locally and NEVER triggers a network fetch (the native-free/offline ethos). A failed
      // fetch degrades (Decision 5): report it, but never fail the rebuild — the tail simply skips.
      //
      // Phase 4: with LUX_EMBEDDING_TOKEN set the ACTIVE path is the API embedder (no local bge weights
      // to fetch), so --embeddings is a NO-OP for the fetch — there is nothing to download. The embed
      // tail still drains to completion (embedToCompletion below) via the API path, which
      // embeddingReadAvailable reports available on the token alone.
      if (options.embeddings && !process.env.LUX_EMBEDDING_TOKEN) {
        if (!options.quiet) {
          console.log('Fetching embedding model (~34 MB, one-time)…');
        }
        try {
          await ensureModelWeights();
        } catch (error) {
          console.error(
            `Note: could not fetch the embedding model ` +
              `(${error instanceof Error ? error.message : String(error)}); ` +
              `continuing without anchor embeddings.`
          );
        }
      }

      await persistKnowledgeIndex(db, scanner, result, progress, {
        invocationId,
        startedAt,
        corpusPath,
        dbPath,
        // Not yet known here — the rebuild command resolves HEAD later, and only for git corpora. The
        // embed usage event simply omits `repoCommit` on this path, same gap as the existing
        // `index-rebuild` usage event on this command.
        headCommit: undefined,
        quiet: options.quiet === true,
        // A1: --embeddings is the explicit "enable embeddings" opt-in — after fetching the weights it
        // must reach FULL coverage on this run, not embed one 30s budget's worth and leave the rest for
        // later syncs. This flags the tail to drain the queue to completion. The DEFAULT rebuild (no
        // flag) leaves it undefined ⇒ the single budgeted pass, so a routine rebuild never blocks.
        embedToCompletion: options.embeddings === true,
      });

      // Write module dependencies
      if (generalResult.dependencies.length > 0) {
        try {
          const database = db; // const so the narrowed (non-undefined) type survives into the closure
          database.transaction(() => {
            database.clearModuleDependencies();
            for (const dep of generalResult.dependencies) {
              database.insertModuleDependency({
                source_module: dep.source_module,
                target_module: dep.target_module,
                reference_count: dep.reference_count,
                sample_files: JSON.stringify(dep.sample_files),
              });
            }
          });
        } catch (error) {
          if (!options.quiet) {
            console.warn(
              `Warning: Failed to write module dependencies: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Log event with error handling
      try {
        db.insertEvent({
          source: 'cli',
          event_type: 'index_rebuild',
          summary: options.contentOnly
            ? `Content-only rebuild: ${result.knowledge.length} knowledge entries`
            : `Overlay-complete rebuild: ${result.knowledge.length} entries, mode=${overlayResult?.mode ?? 'unknown'}`,
        });
      } catch {
        // Non-fatal: log but don't fail
        if (!options.quiet) {
          console.warn('Warning: Failed to log rebuild event');
        }
      }

      emitUsageEvent(db, {
        source: 'cli',
        surface: 'index-rebuild',
        action: options.contentOnly ? 'content-only' : 'overlay-complete',
        invocationId,
        commandOutcome: 'success',
        retrievalOutcome: 'not_applicable',
        trustState: options.contentOnly ? 'content-only' : safeUsageTrustState(overlayResult?.mode),
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        corpusPath,
        dbPath,
        attributes: {
          entries: result.knowledge.length,
          overlayMode: overlayResult?.mode ?? (options.contentOnly ? 'content-only' : 'unknown'),
          surfaceCount: overlayResult?.surfaceCount,
        },
      });

      // Store HEAD commit hash if this is a git repo
      if (isGitRepository(corpusPath)) {
        try {
          const headCommit = getHeadCommit(corpusPath);
          headCommitForTrustState = headCommit;
          db.setIndexMetadata('last_indexed_commit', headCommit);
          if (!options.quiet) {
            console.log(`Stored commit hash: ${headCommit.slice(0, 8)}`);
          }
        } catch {
          if (!options.quiet) {
            console.warn('Warning: Failed to store git commit hash');
          }
        }
      }

      persistCoverageProducerRuns(db, generalResult);
      if (overlayResult) {
        persistRebuildTrustState(db, overlayResult, {
          lastIndexedCommit: headCommitForTrustState,
        });
        persistStructuralConfigFingerprint(corpusPath, db);
      }

      progress.finish('index rebuild complete');
      if (!options.quiet) {
        if (overlayResult) {
          printRebuildTrustSummary(overlayResult);
        } else {
          printRebuildTrustSummary({
            mode: 'content-only',
            repoPath: corpusPath,
            configSource: 'lux.yaml',
            configLspEnabled: false,
            surfaceCount: 0,
            detectorEdgeCount: 0,
            propagatedEdgeCount: 0,
            fileNodeCount: 0,
            symbolNodeCount: 0,
            controllerBackedCount: 0,
            closureBackedCount: 0,
            unknownProviderKindCount: 0,
            enrichmentStatus: 'inactive',
            propagationStatus: 'skipped',
            warnings: [],
          });
        }
        console.log('\n✓ Index rebuilt successfully');
      } else {
        if (overlayResult) {
          console.log(
            `✓ Index rebuilt successfully (${overlayResult.mode}, ${overlayResult.surfaceCount} surfaces, ${overlayResult.symbolNodeCount} symbols)`
          );
        } else {
          console.log('✓ Index rebuilt successfully (content-only)');
        }
      }

      db.close();
    } catch (error) {
      // Catch-all for unexpected errors
      console.error('Error: Unexpected error during index rebuild');
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      }
      process.exit(1);
    }
  });

indexCmd
  .command('sync')
  .description('Incrementally update index based on git changes')
  .option('--quiet', 'Suppress output')
  .option('--force', 'Ignore stored commit, do full rebuild')
  .option(
    '--mark-only',
    'Downgrade overlay edges for structural changes instead of rebuilding (Phase 2)'
  )
  .option(
    '--scoped',
    'Force scoped refresh (repair changed files + reverse-import closure), overriding the escalation policy (preconditions still apply)'
  )
  .option(
    '--full',
    'Force a full overlay rebuild instead of the scoped-by-default refresh (Phase 3b)'
  )
  .action(
    async (options: {
      quiet?: boolean;
      force?: boolean;
      markOnly?: boolean;
      scoped?: boolean;
      full?: boolean;
    }) => {
      const { corpusPath, dbPath } = getRuntimePaths(program);
      const invocationId = createInvocationId();
      const startedAt = Date.now();
      let db: LuxDatabase | undefined;

      try {
        // Validate content directory
        if (!existsSync(corpusPath)) {
          console.error(`Error: Content directory not found: ${corpusPath}`);
          process.exit(1);
        }

        // Check if this is a git repo
        if (!isGitRepository(corpusPath)) {
          console.error('Error: Content directory is not a git repository');
          const nestedRepo = findLikelyNestedGitRoot(corpusPath);
          if (nestedRepo) {
            console.error(`  Hint: found a nested git repository at ${nestedRepo}`);
            console.error('  Try rerunning with --corpus pointed at that repo root.');
          } else {
            console.error('  Use "lux index rebuild" for non-git directories');
          }
          process.exit(1);
        }

        // Initialize database
        try {
          db = new LuxDatabase(dbPath);
        } catch (error) {
          console.error(`Error: Failed to initialize database: ${dbPath}`);
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }

        if (!db.isSchemaUpToDate()) {
          console.error('Error: Database schema is not up to date');
          console.error('  Run "lux migrate" to update the schema');
          db.close();
          process.exit(1);
        }

        const lastCommit = db.getIndexMetadata('last_indexed_commit');

        // If --force or no stored commit, fall back to full rebuild
        if (options.force || !lastCommit) {
          if (!options.quiet) {
            if (options.force) {
              console.log('Force flag set, running full rebuild...');
            } else {
              console.log('No previous index commit found, running full rebuild...');
            }
          }
          try {
            const scanner = new GeneralScanner(corpusPath);
            const progress = createProgressReporter(options.quiet === true);
            progress.start('index rebuild (overlay-complete)');
            progress.log(`Scanning content directory: ${corpusPath}`);

            const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
              onProgress: (msg) => progress.log(msg),
            });
            const indexedScan = {
              ...scanResult.scan,
              knowledge: scanResult.scan.knowledge.map((entry) =>
                attachEnrichment(entry, scanResult.enrichments)
              ),
            };
            await persistKnowledgeIndex(db, scanner, indexedScan, progress, {
              invocationId,
              startedAt,
              corpusPath,
              dbPath,
              // Computed locally right below (`const headCommit = getHeadCommit(corpusPath);`) —
              // too late for this call. Same gap as the rebuild command's call site.
              headCommit: undefined,
              quiet: options.quiet === true,
            });
            const headCommit = getHeadCommit(corpusPath);
            db.setIndexMetadata('last_indexed_commit', headCommit);
            persistCoverageProducerRuns(db, scanResult);
            persistRebuildTrustState(db, result, {
              lastIndexedCommit: headCommit,
            });
            persistStructuralConfigFingerprint(corpusPath, db);
            progress.finish('index rebuild complete');

            if (!options.quiet) {
              printRebuildTrustSummary(result);
              console.log(
                `\n✓ Full rebuild complete (${result.surfaceCount} surfaces, commit ${headCommit.slice(0, 8)})`
              );
            }

            db.close();
            return;
          } catch (error) {
            console.error('Error: Failed to run full overlay rebuild');
            console.error(`  ${error instanceof Error ? error.message : String(error)}`);
            db.close();
            process.exit(1);
          }
        }

        // Verify stored commit still exists
        if (!commitExists(corpusPath, lastCommit)) {
          if (!options.quiet) {
            console.warn(
              'Warning: Stored commit no longer exists (possible force push), running full rebuild...'
            );
          }
          try {
            const scanner = new GeneralScanner(corpusPath);
            const progress = createProgressReporter(options.quiet === true);
            progress.start('index rebuild (overlay-complete)');
            progress.log(`Scanning content directory: ${corpusPath}`);

            const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
              onProgress: (msg) => progress.log(msg),
            });
            const indexedScan = {
              ...scanResult.scan,
              knowledge: scanResult.scan.knowledge.map((entry) =>
                attachEnrichment(entry, scanResult.enrichments)
              ),
            };
            await persistKnowledgeIndex(db, scanner, indexedScan, progress, {
              invocationId,
              startedAt,
              corpusPath,
              dbPath,
              // Computed locally right below (`const headCommit = getHeadCommit(corpusPath);`) —
              // too late for this call. Same gap as the rebuild command's call site.
              headCommit: undefined,
              quiet: options.quiet === true,
            });
            const headCommit = getHeadCommit(corpusPath);
            db.setIndexMetadata('last_indexed_commit', headCommit);
            persistCoverageProducerRuns(db, scanResult);
            persistRebuildTrustState(db, result, {
              lastIndexedCommit: headCommit,
            });
            persistStructuralConfigFingerprint(corpusPath, db);
            progress.finish('index rebuild complete');

            if (!options.quiet) {
              printRebuildTrustSummary(result);
              console.log(
                `\n✓ Full rebuild complete (${result.surfaceCount} surfaces, commit ${headCommit.slice(0, 8)})`
              );
            }

            db.close();
            return;
          } catch (error) {
            console.error('Error: Failed to run full overlay rebuild');
            console.error(`  ${error instanceof Error ? error.message : String(error)}`);
            db.close();
            process.exit(1);
          }
        }

        // Get HEAD commit
        const headCommit = getHeadCommit(corpusPath);

        // Check if already up to date (commit-wise) — but report the working tree honestly.
        if (headCommit === lastCommit) {
          if (!options.quiet) {
            const freshness = assessWorkingTreeFreshness(corpusPath, db);
            if (freshness.assessment === 'clean') {
              console.log(`Index matches HEAD (${headCommit.slice(0, 8)}); working tree clean.`);
            } else if (freshness.assessment === 'dirty-content') {
              console.log(
                `Index matches HEAD (${headCommit.slice(0, 8)}); working tree dirty: ` +
                  `${freshness.dirtyFiles.length} non-structural file(s).`
              );
            } else {
              // dirty-structural
              console.log(
                `Index matches HEAD (${headCommit.slice(0, 8)}); working tree dirty: ` +
                  `${freshness.dirtyStructural.length} structural file(s).`
              );
              for (const p of freshness.dirtyStructural.slice(0, 20)) {
                console.log(`  → overlay facts for ${p} describe the last indexed state`);
              }
            }
          }
          // Resume seam (03 §integration points — load-bearing): a budget-interrupted prior embed pass
          // leaves un-embedded anchor nodes behind even though the git commit hasn't moved. Running
          // runNodeEmbedTail here — BEFORE the early return below — is what makes "the remainder embeds
          // on the next sync" true even when this sync has no content changes at all; skipped nodes
          // would otherwise never be revisited until some future commit changed the tree. When coverage
          // is already complete the queue returns zero rows, so this skips the 34 MB model load (not a
          // free check — the queue read still scans structural_node_texts) and re-parses nothing (the
          // prepared text is already persisted).
          await runNodeEmbedTail(
            db,
            invocationId,
            startedAt,
            corpusPath,
            dbPath,
            headCommit,
            options.quiet === true
          );
          db.close();
          return;
        }

        if (!options.quiet) {
          console.log(`Syncing index: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
        }

        // Get git diff
        let diff;
        try {
          diff = getGitDiff(corpusPath, lastCommit, headCommit);
        } catch {
          if (!options.quiet) {
            console.warn('Warning: git diff failed, running full rebuild...');
          }
          try {
            const scanner = new GeneralScanner(corpusPath);
            const progress = createProgressReporter(options.quiet === true);
            progress.start('index rebuild (overlay-complete)');
            progress.log(`Scanning content directory: ${corpusPath}`);

            const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
              onProgress: (msg) => progress.log(msg),
            });
            const indexedScan = {
              ...scanResult.scan,
              knowledge: scanResult.scan.knowledge.map((entry) =>
                attachEnrichment(entry, scanResult.enrichments)
              ),
            };
            await persistKnowledgeIndex(db, scanner, indexedScan, progress, {
              invocationId,
              startedAt,
              corpusPath,
              dbPath,
              headCommit, // already computed above at the sync command's `const headCommit` — in scope here
              quiet: options.quiet === true,
            });
            db.setIndexMetadata('last_indexed_commit', headCommit);
            persistCoverageProducerRuns(db, scanResult);
            persistRebuildTrustState(db, result, {
              lastIndexedCommit: headCommit,
            });
            persistStructuralConfigFingerprint(corpusPath, db);
            progress.finish('index rebuild complete');
            if (!options.quiet) {
              printRebuildTrustSummary(result);
              console.log(`\n✓ Full rebuild complete (${result.surfaceCount} surfaces)`);
            }
            db.close();
            return;
          } catch (error) {
            console.error('Error: Failed to run full overlay rebuild');
            console.error(`  ${error instanceof Error ? error.message : String(error)}`);
            db.close();
            process.exit(1);
          }
        }

        const overlayRelevantPaths = collectOverlayRelevantPaths(diff);
        const requiresOverlayRebuild = hasOverlayRelevantChanges(diff);

        // Phase 2 (Decisions 3/4/11): --mark-only downgrades a structural change (marks edges + trust)
        // instead of escalating to a full rebuild. It skips the escalation and falls through to the
        // incremental-content path, where the two dimension marks + the trust downgrade are applied
        // before the pointer settles. OQ4-safe: `lux delta` now reads the maintained marks (spec 12).
        if (requiresOverlayRebuild && !options.markOnly) {
          // Phase 3b (T3b.4, spec 15 Part E): scoped refresh is the DEFAULT sync path under budget,
          // routed by decideScopedEligibility (the whole escalation policy — no-overlay /
          // pending-migration / first-party / config-changed / over-budget). `--full` forces the
          // full-rebuild escalation; `--scoped` forces scoped via decideForcedScoped (operator
          // override: the two HARD preconditions still apply, but the fingerprint/first-party/budget
          // POLICY is bypassed). This is the ONE precondition implementation — the Phase-3a inline
          // check is now subsumed by decideForcedScoped.
          const decision: ScopedDecision = options.full
            ? { path: 'full', reason: 'config-changed' } // --full: operator forces full
            : options.scoped
              ? decideForcedScoped(db, corpusPath) // --scoped: force scoped unless a HARD precondition blocks
              : decideScopedEligibility(db, corpusPath, overlayRelevantPaths.length);

          if (decision.path === 'scoped') {
            const changed: ChangedFile[] = collectOverlayRelevantPaths(diff).map((relPath) => ({
              relPath,
              status: diff.deleted.includes(relPath)
                ? 'deleted'
                : diff.added.includes(relPath)
                  ? 'added'
                  : 'modified',
            }));
            const prior = inspectOverlayTrustState(db).state;
            const config = loadLspConfig(corpusPath);
            const progress = createProgressReporter(options.quiet === true);
            progress.start('scoped overlay refresh');
            const result = await refreshOverlayScoped(db, corpusPath, changed, config, {
              onProgress: (m) => progress.log(m),
              lspBudgetMs: decision.lspBudgetMs, // Phase 3b: sourced from refresh.lspBudgetMs (spec 15 C/E)
            });
            // Content index still reflects HEAD (the incremental content sync runs for docs).
            const plan = buildIncrementalPlan(corpusPath, diff);
            const contentDb = db; // const so the narrowed (non-undefined) type survives into the closure
            contentDb.transaction(() => {
              for (const p of plan.toDelete) contentDb.deleteKnowledgeEntryByPath(p);
              for (const entry of plan.toIndex) {
                contentDb.insertKnowledgeEntry({
                  type: entry.type,
                  title: entry.title,
                  file_path: entry.filePath,
                  tags: entry.tags,
                  metadata: entry.frontmatter,
                  content: entry.content,
                });
              }
            });
            db.setIndexMetadata('last_indexed_commit', headCommit); // OQ4-safe (Phase 2 mark-read landed)
            persistScopedCoverageProducerRuns(
              db,
              result,
              changed.map((file) => file.relPath)
            );
            if (prior) {
              persistRefreshTrustState(db, prior, {
                lastIndexedCommit: headCommit,
                residualStaleEdges: result.residualStaleEdges,
              });
            }
            emitUsageEvent(db, {
              source: 'cli',
              surface: 'index-refresh',
              action: 'scoped',
              invocationId,
              commandOutcome: 'success',
              retrievalOutcome: 'not_applicable',
              trustState: safeUsageTrustState(deriveOverlayTrustLevel(db)),
              durationMs: Date.now() - startedAt,
              exitCode: 0,
              corpusPath,
              dbPath,
              repoCommit: headCommit,
              attributes: {
                refreshedFiles: result.refreshedFiles,
                changedFiles: result.changedFiles,
                closureFiles: result.closureFiles,
                residualStaleEdges: result.residualStaleEdges,
                tierAst: result.tiers.ast,
                tierLsp: result.tiers.lsp,
                tierFacade: result.tiers.facade,
              },
            });
            progress.finish(
              `scoped refresh complete (${result.refreshedFiles} file(s), ${result.residualStaleEdges} residual stale)`
            );
            // Scoped tail: the victim-sibling delete (Part C) dropped changed nodes' stale vectors just
            // above (overlay-refresh.ts), so those same-id nodes re-enter the queue and get re-embedded
            // here. headCommit is in scope (this branch runs after the outer getHeadCommit).
            await runNodeEmbedTail(
              db,
              invocationId,
              startedAt,
              corpusPath,
              dbPath,
              headCommit,
              options.quiet === true
            );
            db.close();
            return;
          }

          // decision.path === 'full' — full-rebuild escalation (unchanged) + fingerprint baseline.
          if (!options.quiet) {
            console.log(`Sync path: full rebuild (${decision.reason}).`);
          }
          try {
            const scanner = new GeneralScanner(corpusPath);
            const progress = createProgressReporter(options.quiet === true);
            progress.start('index rebuild (overlay-complete)');
            progress.log(`Scanning content directory: ${corpusPath}`);

            const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
              onProgress: (msg) => progress.log(msg),
            });
            const indexedScan = {
              ...scanResult.scan,
              knowledge: scanResult.scan.knowledge.map((entry) =>
                attachEnrichment(entry, scanResult.enrichments)
              ),
            };
            await persistKnowledgeIndex(db, scanner, indexedScan, progress, {
              invocationId,
              startedAt,
              corpusPath,
              dbPath,
              headCommit, // already computed above at the sync command's `const headCommit` — in scope here
              quiet: options.quiet === true,
            });
            db.setIndexMetadata('last_indexed_commit', headCommit);
            persistCoverageProducerRuns(db, scanResult);
            persistRebuildTrustState(db, result, {
              lastIndexedCommit: headCommit,
            });
            persistStructuralConfigFingerprint(corpusPath, db);
            progress.finish('index rebuild complete');

            try {
              db.insertEvent({
                source: 'cli',
                event_type: 'index_sync',
                summary: `Sync escalated to overlay rebuild: ${overlayRelevantPaths.length} structural source file(s) changed`,
              });
            } catch {
              // Non-fatal
            }
            emitUsageEvent(db, {
              source: 'cli',
              surface: 'index-sync',
              action: 'overlay-rebuild',
              invocationId,
              commandOutcome: 'success',
              retrievalOutcome: 'not_applicable',
              trustState: safeUsageTrustState(result.mode),
              durationMs: Date.now() - startedAt,
              exitCode: 0,
              corpusPath,
              dbPath,
              repoCommit: headCommit,
              attributes: {
                overlayRelevantPaths: overlayRelevantPaths.length,
                surfaceCount: result.surfaceCount,
              },
            });

            if (!options.quiet) {
              printRebuildTrustSummary(result);
              console.log(
                `\n✓ Sync escalated to full overlay rebuild (${result.surfaceCount} surfaces, commit ${headCommit.slice(0, 8)})`
              );
            }

            db.close();
            return;
          } catch (error) {
            console.error('Error: Failed to run overlay rebuild during sync');
            console.error(`  ${error instanceof Error ? error.message : String(error)}`);
            db.close();
            process.exit(1);
          }
        }

        // Build incremental plan
        const plan = buildIncrementalPlan(corpusPath, diff);

        if (!options.quiet) {
          console.log(
            'Sync path: incremental content sync (no structural source changes detected).'
          );
          console.log(
            `Changes: +${diff.added.length} added, ~${diff.modified.length} modified, -${diff.deleted.length} deleted`
          );
          console.log(
            `Indexable: ${plan.toIndex.length} to index, ${plan.toDelete.length} to delete`
          );
        }

        // Delete removed entries from DB
        const deletingDb = db; // const so the narrowed (non-undefined) type survives into the closure
        deletingDb.transaction(() => {
          for (const filePath of plan.toDelete) {
            deletingDb.deleteKnowledgeEntryByPath(filePath);
          }
        });

        // LSP enrichment for changed source files only
        const sourceFilesToEnrich = plan.toIndex
          .filter((entry) => entry.type === 'source-code')
          .map((entry) => entry.filePath);

        if (sourceFilesToEnrich.length > 0) {
          try {
            const { loadLspConfig } = await import('../scanner/config.js');
            const { EnricherRegistry } = await import('../scanner/lsp/index.js');
            const { PhpLspEnricher } = await import('../scanner/lsp/php.js');
            const config = loadLspConfig(corpusPath);

            if (config.lsp.enabled) {
              if (!options.quiet) {
                console.log(`Enriching ${sourceFilesToEnrich.length} source files via LSP...`);
              }

              // Build enricher registry from config (same as generalScan but targeted)
              const registry = new EnricherRegistry();
              const ENRICHER_FACTORIES: Record<
                string,
                (entry: (typeof config.lsp.enrichers)[0]) => InstanceType<typeof PhpLspEnricher>
              > = {
                php: (entry) =>
                  new PhpLspEnricher({
                    serverCommand: entry.serverCommand,
                    serverArgs: entry.serverArgs,
                    maxConcurrency: entry.maxConcurrency,
                    requestTimeoutMs: entry.requestTimeoutMs,
                    initTimeoutMs: entry.initTimeoutMs,
                  }),
              };

              for (const entry of config.lsp.enrichers) {
                if (entry.enabled === false) continue;
                const factory = ENRICHER_FACTORIES[entry.languageId];
                if (!factory) continue;
                try {
                  registry.register(factory(entry));
                } catch {
                  /* skip */
                }
              }

              // Initialize enrichers
              const workspaceRoot = config.lsp.workspaceRoot ?? corpusPath;
              for (const enricher of registry.getAll()) {
                try {
                  await enricher.initialize(workspaceRoot);
                } catch {
                  /* skip */
                }
              }

              // Enrich ONLY the changed files
              const path = await import('path');
              const enrichmentMap = new Map<
                string,
                import('../scanner/lsp/index.js').EnrichmentResult
              >();

              for (const filePath of sourceFilesToEnrich) {
                const ext = path.extname(filePath);
                const enricher = registry.getByExtension(ext);
                if (!enricher?.isReady) continue;
                try {
                  const result = await enricher.enrich(filePath);
                  if (result) enrichmentMap.set(filePath, result);
                } catch {
                  /* skip individual file errors */
                }
              }

              // Shut down enrichers
              try {
                await registry.shutdownAll();
              } catch {
                /* ignore */
              }

              // Apply enrichments to changed files
              for (let i = 0; i < plan.toIndex.length; i++) {
                const entry = plan.toIndex[i];
                if (enrichmentMap.has(entry.filePath)) {
                  plan.toIndex[i] = attachEnrichment(entry, enrichmentMap);
                }
              }

              if (!options.quiet && enrichmentMap.size > 0) {
                console.log(`  Enriched ${enrichmentMap.size} files via LSP`);
              }
            }
          } catch {
            if (!options.quiet) {
              console.warn('Warning: LSP enrichment failed, continuing without enrichment');
            }
          }
        }

        // Phase 2 (Decision 3/4/11): commit the content-index inserts, the two --mark-only stale-mark
        // dimensions (node-path: endpoints in a changed file; evidence: a changed file cited by an
        // edge whose endpoints are elsewhere — e.g. a routes-file handled_by edge), and the
        // last_indexed_commit pointer advance as ONE transaction, with the MARKS WRITTEN BEFORE THE
        // POINTER. Marks-before-pointer is the crash-atomic order (OQ4): a crash after the marks but
        // before the pointer leaves the pointer behind HEAD, so `lux delta base..HEAD` still catches
        // the files; advancing the pointer first would strand a clean tree over an unmarked overlay.
        const database = db; // const so the narrowed (non-undefined) type survives into the closure
        const { edgesMarkedNodePath, edgesMarkedEvidence } = commitIncrementalSync(
          database,
          () => {
            for (const entry of plan.toIndex) {
              database.insertKnowledgeEntry({
                type: entry.type,
                title: entry.title,
                file_path: entry.filePath,
                tags: entry.tags,
                metadata: entry.frontmatter,
                content: entry.content,
              });
            }
          },
          { overlayRelevantPaths, headCommit, markOnly: options.markOnly === true }
        );

        const syncTrustState = markOverlayTrustAfterSync(db, {
          lastIndexedCommit: headCommit,
          overlayRelevantPaths,
          addedCount: diff.added.length,
          modifiedCount: diff.modified.length,
          deletedCount: diff.deleted.length,
          indexedCount: plan.toIndex.length,
          deletedEntryCount: plan.toDelete.length,
        });

        // Log event
        try {
          db.insertEvent({
            source: 'cli',
            event_type: 'index_sync',
            summary: `Synced index: +${plan.toIndex.length} indexed, -${plan.toDelete.length} deleted`,
          });
        } catch {
          // Non-fatal
        }
        const markOnlyRun = options.markOnly === true && overlayRelevantPaths.length > 0;
        emitUsageEvent(db, {
          source: 'cli',
          surface: 'index-sync',
          action: markOnlyRun ? 'mark-only' : 'incremental',
          invocationId,
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          trustState: safeUsageTrustState(deriveOverlayTrustLevelFromState(syncTrustState)),
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          corpusPath,
          dbPath,
          repoCommit: headCommit,
          attributes: {
            indexedCount: plan.toIndex.length,
            deletedEntryCount: plan.toDelete.length,
            addedCount: diff.added.length,
            modifiedCount: diff.modified.length,
            deletedCount: diff.deleted.length,
            overlayRelevantPaths: overlayRelevantPaths.length,
            edgesMarkedNodePath,
            edgesMarkedEvidence,
          },
        });

        if (!options.quiet) {
          if (markOnlyRun) {
            console.log(
              `Sync path: mark-only edge downgrade (${overlayRelevantPaths.length} structural source file(s) changed; ` +
                `${edgesMarkedNodePath} edge(s) by node-path, ${edgesMarkedEvidence} by evidence marked stale — overlay NOT rebuilt).`
            );
          }
          const syncTrustLevel = deriveOverlayTrustLevelFromState(syncTrustState);
          console.log(
            `Overlay trust after sync: ${syncTrustLevel} (persisted mode: ${syncTrustState.mode}, ${syncTrustState.fileNodeCount} files, ${syncTrustState.symbolNodeCount} symbols)`
          );
          for (const warning of syncTrustState.warnings) {
            console.warn(`Warning: ${warning}`);
          }
          console.log(
            `✓ Synced: +${plan.toIndex.length} indexed, -${plan.toDelete.length} deleted (commit ${headCommit.slice(0, 8)})`
          );
        }

        // Incremental tail: after the content sync settles the pointer, embed any anchor nodes the
        // materialization added/changed this sync (plus any resume backlog). headCommit is in scope.
        await runNodeEmbedTail(
          db,
          invocationId,
          startedAt,
          corpusPath,
          dbPath,
          headCommit,
          options.quiet === true
        );
        db.close();
      } catch (error) {
        console.error('Error: Unexpected error during index sync');
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        if (db) {
          try {
            db.close();
          } catch {
            /* ignore */
          }
        }
        process.exit(1);
      }
    }
  );

indexCmd
  .command('status')
  .description('Show index statistics and overlay state')
  .option('--json', 'Emit machine-readable JSON instead of human-readable text')
  .action((options: { json?: boolean }) => {
    const runtime = getRuntimePaths(program);
    const db = openCliReadIndex(runtime.dbPath, options.json ?? false);
    if (!db) return;

    const stats = db.getStats();
    const inspection = inspectOverlayTrustState(db);
    const diagnostics = describeOverlayTrustInspection(inspection);

    if (options.json) {
      console.log(JSON.stringify(withReadTelemetry(buildIndexStatusPayload(db, runtime)), null, 2));
      db.close();
      return;
    }

    console.log('\nIndex Statistics:\n');
    console.log(`  Corpus: ${runtime.corpusPath} (${runtime.corpusSource})`);
    console.log(`  Database: ${runtime.dbPath} (${runtime.dbSource})`);
    console.log(`  Knowledge Entries: ${stats.knowledge_entries}`);
    console.log(`  Events: ${stats.events}`);

    console.log('\nStructural Overlay:');
    if (!inspection.state) {
      console.log(`  Trust Level: ${diagnostics.trustLevel}`);
      for (const warning of diagnostics.warnings) {
        console.log(`  ${warning}`);
      }
    } else {
      const overlay = inspection.state;
      console.log(`  Mode: ${overlay.mode}`);
      console.log(`  Trust Level: ${diagnostics.trustLevel}`);
      console.log(`  Surfaces: ${overlay.surfaceCount}`);
      console.log(`  Nodes: ${overlay.fileNodeCount} files, ${overlay.symbolNodeCount} symbols`);
      console.log(
        `  Provider kinds: ${overlay.controllerBackedCount} controller-backed, ` +
          `${overlay.closureBackedCount} closure-backed, ${overlay.unknownProviderKindCount} unknown`
      );
      console.log(`  Trust source: ${diagnostics.trustSource}`);
      if (overlay.lastIndexedCommit) {
        console.log(`  Indexed commit: ${overlay.lastIndexedCommit.slice(0, 8)}`);
      }
      if (overlay.recordedAt) {
        console.log(`  Trust recorded: ${overlay.recordedAt}`);
      }
      if (diagnostics.warnings.length > 0) {
        for (const warning of diagnostics.warnings) {
          console.warn(`Warning: ${warning}`);
        }
      }
    }
    console.log();

    // Freshness (Decision 1) — computed on read, never persisted.
    for (const line of renderFreshnessText(assessWorkingTreeFreshness(runtime.corpusPath, db))) {
      console.log(line);
    }

    db.close();
  });

// Add search command
addSearchCommand(program);

// Add anchors command (concept→structural-node anchor minting)
registerAnchorsCommand(program);

// Add hooks command
addHooksCommand(program);

// Add migration commands
addMigrateCommands(program);

// Add deps command
addDepsCommand(program);

// Add vendor-pack command
addVendorPackCommands(program);

// Add trace command
addTraceCommand(program);

// Add overlay commands
addOverlayCommands(program);

// Add usage observability commands
addUsageCommands(program);

// Add delta command
addDeltaCommand(program);

// Add siblings command
addSiblingsCommand(program);

// Add safe portable configuration preview/apply command
registerInitCommand(program);

// Add read-only production diagnostics command
registerDoctorCommand(program);

// ---------------------------------------------------------------------------
// Anchor embed-pass helpers (spec 16 Part B) — the four terminal-point tail
// ---------------------------------------------------------------------------
//
// PLACEMENT (reconciliation vs spec-16 line numbers): spec 16 places these in the post-`persistKnow-
// ledgeIndex` "Helpers" region. In the CURRENT file `program.parse()` runs BEFORE that region, and the
// no-change resume seam (Part B.5) reaches `runNodeEmbedTail` with NO prior `await` — so its
// synchronous prefix runs inside the `program.parse()` call stack. The three helpers are function
// declarations (hoisted, safe anywhere), but `sharedEmbedderPromise` is a `let` binding: reading it
// before its initializer executes throws a TDZ ReferenceError. Declaring it (and its helpers) BEFORE
// `program.parse()` guarantees it is initialized before any action runs. Spec intent (a process-shared
// memo + the single tail) is preserved verbatim.

/**
 * Process-lifetime memo for the active embedder. `createEmbedder()` fetches/verifies model weights on
 * first use (slow the first time: a network fetch + sha256 verify; cached on disk after — spec 11) —
 * every index path in a given process reuses the resolved instance instead of repeating that cost. In
 * today's CLI one `lux index rebuild`/`sync` process only ever reaches ONE of the four terminal points
 * below (the sync control flow is mutually exclusive per invocation — each branch returns or falls
 * through to its own `db.close()`), so this mostly protects a future multi-invocation-per-process
 * caller (e.g. an integration-test harness driving `rebuild` then `sync` against the exported action
 * functions without restarting the process). A REJECTED promise is NOT cached: a transient
 * weight-fetch failure on one call must not permanently poison every later call in the same process —
 * the next call retries from scratch.
 *
 * PHASE 4: the loaded `embedding` config (from `loadLspConfig(corpusPath).embedding`, resolved once in
 * `runNodeEmbedTail`) is threaded in, so `createEmbedder(config)` selects the ApiEmbedder when
 * `LUX_EMBEDDING_TOKEN` is set (else the tokenless local WasmLocalEmbedder). The memo shape is unchanged
 * (config is process-stable — one corpus per process): the first call fixes the embedder, so a later
 * call's `config` arg is inert, exactly the caching contract Phase 3 established.
 */
let sharedEmbedderPromise: Promise<Embedder> | null = null;

async function getSharedEmbedder(config: EmbeddingConfig | undefined): Promise<Embedder> {
  if (!sharedEmbedderPromise) {
    sharedEmbedderPromise = createEmbedder(config).catch((error: unknown) => {
      sharedEmbedderPromise = null; // do not cache a failure — allow a retry on the next call site
      throw error;
    });
  }
  return sharedEmbedderPromise;
}

/** Strips the `@sha256:...` weights-digest suffix from the active model id for the human-readable
 *  coverage line — the digest is provenance (stored verbatim in `structural_node_embeddings.model` and
 *  returned in `coverage.model`), not something an operator needs on every sync. An API model id
 *  (`'openai:text-embedding-3-small'`) has no `@` and is returned unchanged. */
function shortModelName(model: string): string {
  const at = model.indexOf('@');
  return at === -1 ? model : model.slice(0, at);
}

/** Context threaded into `reportEmbedOutcome` — the usage-event provenance + the quiet flag. */
interface EmbedTailContext {
  db: LuxDatabase;
  invocationId: string;
  startedAt: number;
  corpusPath: string;
  dbPath: string;
  headCommit: string | undefined;
  quiet: boolean;
}

/**
 * Prints the human-readable coverage line (unless quiet) and emits the `index-node-embed` usage
 * event. Called on every non-error terminal of the tail — the embed-pass success path, the
 * queue-empty fast path, and the weights-absent cached-only skip — so a no-op sync and a degraded
 * skip are both still reportable outcomes with honest coverage, exactly like the pre-existing
 * success-path event. `coverage.model` (the ACTIVE model — ANCHOR_EMBED_MODEL locally, or
 * `openai:<model>` on the API path) drives the display name, so no embedder instance is needed here.
 */
function reportEmbedOutcome(
  ctx: EmbedTailContext,
  result: NodeEmbedPassResult,
  opts: { emitConsole?: boolean } = {}
): void {
  const emitConsole = opts.emitConsole ?? true;
  const { embedded, budgetHit, coverage } = result;
  const coveragePct =
    coverage.anchorViableNodes > 0
      ? Math.round((coverage.embeddedNodes / coverage.anchorViableNodes) * 100)
      : 100;

  // A3: the coverage line prints only when embeddings are ACTIVE for this outcome (a completed queue,
  // or a pass that ran on cached weights). The weights-not-cached skip passes `emitConsole:false` so a
  // machine that never opted into embeddings stays silent on stdout — but the usage event below is
  // ALWAYS emitted, so the skip is still a recorded, honest outcome in telemetry.
  if (!ctx.quiet && emitConsole) {
    const remaining = coverage.anchorViableNodes - coverage.embeddedNodes;
    let line =
      `Anchor embeddings: ${coverage.embeddedNodes}/${coverage.anchorViableNodes} anchor nodes ` +
      `under ${shortModelName(coverage.model)} (${coveragePct}%)`;
    if (budgetHit && remaining > 0) {
      line += ` — ${remaining} remaining, will embed on next sync`;
    }
    console.log(line);
  }

  emitUsageEvent(ctx.db, {
    source: 'cli',
    surface: 'index-node-embed',
    action: 'embed',
    invocationId: ctx.invocationId,
    commandOutcome: 'success',
    retrievalOutcome: 'not_applicable',
    durationMs: Date.now() - ctx.startedAt,
    exitCode: 0,
    corpusPath: ctx.corpusPath,
    dbPath: ctx.dbPath,
    repoCommit: ctx.headCommit,
    attributes: {
      embedded,
      budgetHit,
      coveragePct,
      anchorViableNodes: coverage.anchorViableNodes,
    },
  });
}

/**
 * A1: per-pass budget for the `--embeddings` full drain. A finite but effectively unbounded wall-clock
 * cap (~1 year) — vs the default 30s `ANCHOR_EMBED_BUDGET_MS` — so one `--embeddings` run drains the
 * whole queue rather than one budget's worth. Kept finite (not `Infinity`) so `Date.now() + budgetMs`
 * stays a safe integer. Any real corpus drains in minutes; this value is never actually approached, and
 * the drain loop's `embedded === 0` break is the true termination condition.
 */
const EMBED_DRAIN_BUDGET_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A1: drain the anchor embed queue to FULL coverage — loop `runNodeEmbedPass` at an effectively
 * unbounded budget until the queue is empty (`embedded === 0`) or coverage is complete, printing a
 * concise `Embedding anchor nodes: E/A (pct%)` progress line per pass. Used ONLY on the explicit
 * `lux index rebuild --embeddings` opt-in; the default tail keeps its single budgeted pass so a routine
 * sync never blocks.
 *
 * RESUMABLE / INTERRUPTIBLE (preserved): each vector upsert is its own committed row and the
 * content-hash queue naturally excludes what is already embedded, so a killed drain resumes exactly
 * where it left off on the next index run — this loop only lifts the 30s cap, it does not change the
 * queue's resume contract. The `embedded === 0` break also guards against a non-progressing pass (a
 * persistent embedder failure degrades internally to `budgetHit` with 0 embedded), so the loop can
 * never spin. The single shared `embedder` is reused across every pass — the model loads once.
 */
async function drainNodeEmbedQueue(
  db: LuxDatabase,
  embedder: Embedder,
  quiet: boolean
): Promise<NodeEmbedPassResult> {
  for (;;) {
    const result = await runNodeEmbedPass(db, embedder, {
      budgetMs: EMBED_DRAIN_BUDGET_MS,
      onProgress: quiet ? undefined : (msg) => console.log(`  ${msg}`),
    });
    if (!quiet) {
      const { embeddedNodes, anchorViableNodes } = result.coverage;
      const pct =
        anchorViableNodes > 0 ? Math.round((embeddedNodes / anchorViableNodes) * 100) : 100;
      console.log(`Embedding anchor nodes: ${embeddedNodes}/${anchorViableNodes} (${pct}%)`);
    }
    if (
      result.embedded === 0 ||
      result.coverage.embeddedNodes >= result.coverage.anchorViableNodes
    ) {
      return result;
    }
  }
}

/**
 * Runs the node embed pass at the tail of an index path and reports it — the ONE function all four
 * integration points below route through (`03` §The four embed-pass integration points). Never
 * throws: a failed embed pass must never fail the surrounding `lux index rebuild`/`sync` (Decision 5).
 *
 * QUEUE-GATE + CACHED-ONLY (T3.4 hardening). Two invariants make the index path cheap and offline:
 *   1. Queue-gate: read the needs-embedding queue FIRST (a cheap indexed anti-join against the STATIC
 *      active local model — no embedder load). If it is empty, coverage is already complete: report it
 *      and return WITHOUT ever constructing an embedder (no onnxruntime load, no weight touch). This
 *      is the no-op-sync fast path — a zero-change sync no longer pays a 34 MB model load.
 *   2. Cached-only: when the queue is non-empty, embed IFF the model weights are already present in
 *      the local cache. An index path NEVER triggers a network fetch — a weights-absent machine skips
 *      the pass (the index still succeeds; Decision-5 degrade), quietly. `lux index rebuild
 *      --embeddings` is the explicit opt-in that fetches the weights first, after which this tail
 *      finds them cached and embeds.
 *
 * Skips are reported as a concise non-`Warning:` line to stdout (a `Warning:` reads as an error and an
 * offline machine is not in error), suppressed under `--quiet`.
 */
async function runNodeEmbedTail(
  db: LuxDatabase,
  invocationId: string,
  startedAt: number,
  corpusPath: string,
  dbPath: string,
  headCommit: string | undefined,
  quiet: boolean,
  // A1: when true (the `lux index rebuild --embeddings` opt-in), drain the queue to full coverage
  // instead of running one budgeted pass. Trailing optional so the sync tail call sites are untouched.
  embedToCompletion = false
): Promise<void> {
  const ctx: EmbedTailContext = {
    db,
    invocationId,
    startedAt,
    corpusPath,
    dbPath,
    headCommit,
    quiet,
  };

  // Resolve the ACTIVE model + availability from the corpus's embedding config (Phase 4). With
  // LUX_EMBEDDING_TOKEN set the active model is `openai:<model>` and availability is "the token is set"
  // (no local weight cache on the API path); tokenless it is ANCHOR_EMBED_MODEL, available iff the bge
  // weights are cached. Both mirror createEmbedder's branch EXACTLY (active-model.ts), so the model the
  // queue-gate/coverage key on is always the one getSharedEmbedder → createEmbedder will actually build.
  // loadLspConfig THROWS on a malformed lux.yaml (bad section / inline embedding.token); this tail is
  // contractually "never throws" (it must not fail the caller's rebuild/sync — the no-change resume seam
  // reaches it as the ONLY config parse), so degrade to undefined config (→ local model) rather than
  // crash, matching the read path's wrap-and-degrade. The config-WRITE paths still surface it loudly.
  let embeddingConfig: EmbeddingConfig | undefined;
  try {
    embeddingConfig = loadLspConfig(corpusPath).embedding;
  } catch {
    embeddingConfig = undefined;
  }
  const activeModel = activeEmbeddingModel(embeddingConfig);

  // (1) Queue-gate — gate on the ACTIVE model name, so this needs no embedder instance. `LIMIT 1`
  // answers "is there anything to embed?" — a scan of structural_node_texts, not a free check, but it
  // skips the model load entirely when the queue is empty (no embedder ever constructed). On a
  // model-flip (token set/cleared, or provider/model edited) every stored vector is stale under the new
  // active model, so the queue re-includes all nodes here — the automatic re-embed under the new space.
  const pending = db.getUnembeddedAnchorNodes(activeModel, 1);
  if (pending.length === 0) {
    // Coverage complete under the active model — report and return, never loading an embedder.
    reportEmbedOutcome(ctx, {
      embedded: 0,
      budgetHit: false,
      coverage: db.getAnchorEmbeddingCoverage(activeModel),
    });
    return;
  }

  // (2) Cached-only — there IS work to do, but the index path must not fetch bge weights. Embed only if
  // a read is available without a fetch: the API path (token set) is always available; the local path
  // requires the bge weights already on disk. Otherwise skip (index still succeeds), no network, no hang.
  if (!embeddingReadAvailable(embeddingConfig)) {
    // A3: stay SILENT on stdout by default — no nudge, no coverage line. Nagging every rebuild/sync of
    // a code corpus for users who never opted into embeddings is noise; the capability is discoverable
    // via `--help`/docs, and `--embeddings` is the one fetch path. The usage event is still emitted
    // (emitConsole:false suppresses only the console line), so the skip stays a recorded outcome, and
    // the exit code / degrade semantics are unchanged (the index never fails on absent weights).
    reportEmbedOutcome(
      ctx,
      {
        embedded: 0,
        budgetHit: false,
        coverage: db.getAnchorEmbeddingCoverage(activeModel),
      },
      { emitConsole: false }
    );
    return;
  }

  // A read is available (bge weights cached, or a token is set) → load the embedder (may still fail on
  // a corrupt-weights crash, or an API request failure) and run the pass. Any failure degrades to a
  // concise skip line. The pass itself keys on embedder.model, which equals activeModel by construction.
  let embedder: Embedder;
  try {
    embedder = await getSharedEmbedder(embeddingConfig);
  } catch (error) {
    if (!quiet) {
      console.log(
        `Anchor embeddings: embedder unavailable, skipping embed pass: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }

  let result: NodeEmbedPassResult;
  try {
    // A1: --embeddings drains to full coverage (drainNodeEmbedQueue loops at an unbounded budget); the
    // default tail runs ONE budgeted pass so a routine rebuild/sync never blocks on a long embed. The
    // shared embedder is loaded exactly once above and reused across every drained pass.
    result = embedToCompletion
      ? await drainNodeEmbedQueue(db, embedder, quiet)
      : await runNodeEmbedPass(db, embedder, {
          onProgress: quiet ? undefined : (msg) => console.log(`  ${msg}`),
        });
  } catch (error) {
    // runNodeEmbedPass already degrades internally (it never throws on a budget hit or an embed-time
    // failure — see node-embed-pass.ts). This catch is the second, outermost layer, so that even a
    // wholly unexpected failure (e.g. getAnchorEmbeddingCoverage itself throwing on an already-broken
    // DB) still cannot fail the caller's rebuild/sync.
    if (!quiet) {
      console.log(
        `Anchor embeddings: embed pass failed, skipping: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }

  reportEmbedOutcome(ctx, result);
}

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function persistKnowledgeIndex(
  db: LuxDatabase,
  scanner: GeneralScanner,
  result: Parameters<GeneralScanner['index']>[1],
  progress: ProgressReporter,
  embedTail: {
    invocationId: string;
    startedAt: number;
    corpusPath: string;
    dbPath: string;
    headCommit: string | undefined;
    quiet: boolean;
    /** A1: drain the anchor embed queue to full coverage (the `lux index rebuild --embeddings` opt-in)
     *  instead of the single 30s-budgeted pass. Only the rebuild call site sets this true; every sync
     *  full-rebuild fallback that funnels through here leaves it undefined ⇒ the default budgeted tail. */
    embedToCompletion?: boolean;
  }
): Promise<void> {
  progress.log('Indexing...');

  try {
    await scanner.index(db, result);
  } catch (error) {
    console.error('Error: Failed to index content');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
      if (error.message.includes('UNIQUE constraint')) {
        console.error('  This suggests duplicate entries in your content directory');
      }
    } else {
      console.error(`  ${String(error)}`);
    }
    db.close();
    process.exit(1);
  }

  // Node embed pass (Decision 5/6, D1/D2-equivalent): runs after every successful knowledge-index +
  // overlay write. This one call covers `lux index rebuild` AND all four sync full-rebuild fallbacks —
  // they all funnel through this function. `process.exit(1)` above means everything past the try/catch
  // only runs on success. Never throws past this point (`runNodeEmbedTail` degrades internally, Part
  // B.1). A full rebuild re-embeds the whole plane because the overlay-clear (Part C) drops all three
  // anchor tables first, so every node re-enters the queue via the IS NULL arm.
  await runNodeEmbedTail(
    db,
    embedTail.invocationId,
    embedTail.startedAt,
    embedTail.corpusPath,
    embedTail.dbPath,
    embedTail.headCommit,
    embedTail.quiet,
    embedTail.embedToCompletion ?? false
  );
}

function createProgressReporter(quiet: boolean): ProgressReporter {
  const startedAt = Date.now();
  let lastPhaseAt = startedAt;

  const formatElapsed = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const prefix = quiet ? '' : '  ';

  return {
    start(label: string) {
      console.log(`${prefix}▶ ${label}`);
      lastPhaseAt = Date.now();
    },
    log(message: string) {
      const now = Date.now();
      console.log(
        `${prefix}[+${formatElapsed(now - lastPhaseAt)} | total ${formatElapsed(now - startedAt)}] ${message}`
      );
      lastPhaseAt = now;
    },
    finish(label: string) {
      const totalMs = Date.now() - startedAt;
      console.log(`${prefix}✓ ${label} in ${formatElapsed(totalMs)}`);
    },
  };
}

function printRebuildTrustSummary(r: RebuildResult): void {
  const trustLevel = deriveOverlayTrustLevelFromMode(r.mode, 'index-rebuild');

  console.log(`\nMode: ${r.mode}`);
  console.log(`Trust Level: ${trustLevel}`);

  if (r.mode === 'overlay-complete' || r.mode === 'degraded-overlay') {
    console.log(`Surfaces: ${r.surfaceCount}`);
    if (r.surfaceCount > 0) {
      console.log(
        `Provider kinds: ${r.controllerBackedCount} controller-backed, ` +
          `${r.closureBackedCount} closure-backed, ${r.unknownProviderKindCount} unknown`
      );
    }
    console.log(`Nodes: ${r.fileNodeCount} files, ${r.symbolNodeCount} symbols`);
    console.log(`Edges: ${r.detectorEdgeCount} detector, ${r.propagatedEdgeCount} propagated`);
    console.log(
      `Enrichments: ${
        r.enrichmentStatus === 'active'
          ? 'loaded from repo config'
          : r.configLspEnabled
            ? 'configured but unavailable'
            : 'inactive'
      }`
    );
  } else {
    console.log(
      'This is the fallback path. Run plain "lux index rebuild" for the canonical overlay-complete rebuild.'
    );
  }

  for (const warning of r.warnings) {
    console.warn(`Warning: ${warning}`);
  }
}
