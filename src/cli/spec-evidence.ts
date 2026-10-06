import { writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import {
  assembleSpecDerivationEvidencePacket,
  renderSpecDerivationEvidenceJson,
  renderSpecDerivationEvidenceMarkdown,
  renderSpecDerivationEvidenceText,
  type SpecDerivationEvidencePacketV1,
  type SpecDerivationTargetKind,
} from '../scanner/associations/spec-derivation/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import {
  summarizeStaleSupport,
  staleSupportWarning,
  type StaleSupportSummary,
} from '../scanner/freshness.js';

export interface SpecEvidenceAskOptions {
  json?: boolean;
  target?: string;
  kind?: string;
  out?: string;
}

export interface SpecEvidenceAskExecutionResult {
  packet: SpecDerivationEvidencePacketV1;
  rendered: string;
  exitCode: 0 | 1;
  /** Read-only stale-support annotation over the resolved target's structural edges (SC-4). */
  staleSupport: StaleSupportSummary;
}

const SPEC_EVIDENCE_TARGET_KINDS: readonly SpecDerivationTargetKind[] = [
  'route',
  'handler',
  'job',
  'listener',
  'command',
] as const;

function parseSpecEvidenceTargetKind(kind: string | undefined): SpecDerivationTargetKind {
  if (!kind) {
    throw new Error(
      'Error: --kind is required and must be one of route, handler, job, listener, command.'
    );
  }
  if (!SPEC_EVIDENCE_TARGET_KINDS.includes(kind as SpecDerivationTargetKind)) {
    throw new Error(
      `Error: --kind must be one of route, handler, job, listener, command. Deferred seed targets such as event, service, region, file, and symbol are not supported.`
    );
  }
  return kind as SpecDerivationTargetKind;
}

export function executeSpecEvidenceAsk(
  db: LuxDatabase,
  question: string,
  options: SpecEvidenceAskOptions & { corpusPath: string; dbPath?: string }
): SpecEvidenceAskExecutionResult {
  const kind = parseSpecEvidenceTargetKind(options.kind);
  const target = options.target?.trim() || question.trim();
  if (!target) throw new Error('Error: spec-evidence ask requires a question or --target.');

  const packet = assembleSpecDerivationEvidencePacket(db, {
    question: question.trim() || `What source evidence exists for ${kind} ${target}?`,
    target,
    kind,
    corpusPath: options.corpusPath,
    dbPath: options.dbPath,
  });
  // Stale-aware annotation (Decision 4 / SC-4): read-only — summarize how many of the resolved
  // target's incident structural edges the maintained marks flag `stale`. The packet itself stays
  // byte-identical (the frozen MCP envelope reads `packet`, not this CLI-facing `rendered`).
  const staleSupport = summarizeStaleSupport(
    packet.target.resolvedNodeId ? db.getStructuralEdgesForNode(packet.target.resolvedNodeId) : []
  );

  const rendered = options.json
    ? JSON.stringify(withReadTelemetry({ ...packet, staleSupport }), null, 2)
    : renderSpecDerivationEvidenceText(packet);

  if (options.out) writeSpecEvidenceExport(options.out, packet);

  return {
    packet,
    rendered,
    exitCode: packet.target.resolutionState === 'resolved' ? 0 : 1,
    staleSupport,
  };
}

function writeSpecEvidenceExport(path: string, packet: SpecDerivationEvidencePacketV1): void {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') {
    writeFileSync(path, `${renderSpecDerivationEvidenceJson(packet)}\n`);
    return;
  }
  if (ext === '.md' || ext === '.markdown') {
    writeFileSync(path, renderSpecDerivationEvidenceMarkdown(packet));
    return;
  }
  throw new Error('Error: --out must end in .json, .md, or .markdown for spec-evidence export.');
}

export function runSpecEvidenceAsk(
  program: Command,
  questionParts: string[],
  options: SpecEvidenceAskOptions
): void {
  const question = questionParts.join(' ').trim();
  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });
  const db = openCliReadIndex(dbPath, options.json ?? false);
  if (!db) return;

  try {
    const result = executeSpecEvidenceAsk(db, question, { ...options, corpusPath, dbPath });
    console.log(result.rendered);
    if (!options.json) {
      const staleWarning = staleSupportWarning(result.staleSupport);
      if (staleWarning) console.warn('Warning: ' + staleWarning);
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (error) {
    // lux-intentional-swallow: reported as the command's error output and exit code.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
