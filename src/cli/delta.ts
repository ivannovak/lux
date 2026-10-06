import type { Command } from 'commander';
import { runDeltaCli } from '../scanner/delta/run.js';
import type { ConfidenceClass } from '../db/types.js';

const CONFIDENCE_CLASSES = ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'];

export function addDeltaCommand(program: Command): void {
  program
    .command('delta')
    .description(
      'Analyze what a git change touches structurally: touched symbols/surfaces, downstream entry ' +
        'surfaces, module dependents, kernel/client ownership transitions, invalidated spec-evidence. ' +
        'Read-only w.r.t. structural state; --check gates in CI.'
    )
    .option('--base <ref>', "Diff baseline ref/SHA (default: the index's last_indexed_commit)")
    .option('--committed-only', 'Exclude uncommitted working-tree changes')
    .option('--depth <n>', 'Reverse-walk depth budget', '6')
    .option('--max-nodes <n>', 'Reverse-walk node budget', '2000')
    .option(
      '--min-confidence <class>',
      'proven|artifact-backed|framework-inferred|heuristic',
      'framework-inferred'
    )
    .option('--check', 'Gate mode: exit nonzero on a gate violation or degraded overlay')
    .option('--fail-on <list>', 'Comma-separated gate categories (overrides lux.yaml delta.gates)')
    .option(
      '--baseline-db <path>',
      'Phase 4: sibling .lux index at the base ref for a true overlay diff'
    )
    .option(
      '--against <list>',
      'Cross-repo impact: affected surfaces in registered siblings (name[,name…]|all)'
    )
    .option('--json', 'Emit the stable machine envelope')
    .action(
      async (options: {
        base?: string;
        committedOnly?: boolean;
        depth: string;
        maxNodes: string;
        minConfidence: string;
        check?: boolean;
        failOn?: string;
        baselineDb?: string;
        against?: string;
        json?: boolean;
      }) => {
        const minConfidence: ConfidenceClass = CONFIDENCE_CLASSES.includes(options.minConfidence)
          ? (options.minConfidence as ConfidenceClass)
          : 'framework-inferred';
        await runDeltaCli(program, {
          base: options.base,
          committedOnly: options.committedOnly === true,
          depth: Number.parseInt(options.depth, 10) || 6,
          maxNodes: Number.parseInt(options.maxNodes, 10) || 2000,
          maxFanout: 64,
          minConfidence,
          check: options.check === true,
          failOn: options.failOn
            ? options.failOn
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          baselineDb: options.baselineDb,
          against: options.against
            ? options.against
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          json: options.json === true,
        });
      }
    );
}
