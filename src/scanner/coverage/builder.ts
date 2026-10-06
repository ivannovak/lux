import { relative, sep } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import type { KnowledgeEntry, StructuralEdge, StructuralNode } from '../../db/types.js';
import { loadLspConfig, type LuxLspConfig } from '../config.js';
import { inspectOverlayTrustState } from '../overlay-trust-state.js';
import {
  deriveCapability,
  type CapabilityEvidenceV1,
  type CoverageCapability,
  type LanguageCapabilityCoverageV1,
} from './index.js';
import { loadCoverageProducerRuns } from './producer-runs.js';

const COVERAGE_CAPABILITIES = Object.freeze([
  'syntax',
  'symbols',
  'imports',
  'calls',
  'references',
  'framework',
] as const satisfies readonly CoverageCapability[]);

type RunSignal = 'overlay' | 'knowledge-lsp' | 'unsupported';
type OutputKind = 'nodes' | 'calls' | 'references' | 'framework' | 'none';
interface ProducerDefinition {
  readonly producer: string;
  readonly runSignal: RunSignal;
  readonly output: OutputKind;
  readonly documentedSubset?: boolean;
}

const unsupported = Object.freeze({
  producer: 'none',
  runSignal: 'unsupported',
  output: 'none',
} as const);
const astNodes = (producer: string): ProducerDefinition =>
  Object.freeze({ producer, runSignal: 'overlay', output: 'nodes' });
const astEdges = (producer: string, output: 'calls' | 'references'): ProducerDefinition =>
  Object.freeze({ producer, runSignal: 'overlay', output });
const framework = Object.freeze({
  producer: 'structural-overlay',
  runSignal: 'overlay',
  output: 'framework',
} as const);

/** Closed, deeply immutable inventory: unsupported combinations are explicit. */
export const COVERAGE_PRODUCER_CATALOG = Object.freeze({
  php: Object.freeze({
    syntax: astNodes('php-tree-sitter'),
    symbols: astNodes('php-tree-sitter'),
    imports: unsupported,
    calls: astEdges('php-tree-sitter', 'calls'),
    references: astEdges('php-tree-sitter', 'references'),
    framework,
  }),
  typescript: Object.freeze({
    syntax: astNodes('typescript-tree-sitter'),
    symbols: astNodes('typescript-tree-sitter'),
    imports: unsupported,
    calls: astEdges('typescript-tree-sitter', 'calls'),
    references: astEdges('typescript-tree-sitter', 'references'),
    framework,
  }),
  javascript: Object.freeze({
    syntax: astNodes('javascript-tree-sitter'),
    symbols: astNodes('javascript-tree-sitter'),
    imports: astEdges('javascript-tree-sitter', 'references'),
    calls: astEdges('javascript-tree-sitter', 'calls'),
    references: astEdges('javascript-tree-sitter', 'references'),
    framework,
  }),
  vue: Object.freeze({
    syntax: astNodes('vue-compiler-sfc'),
    symbols: astNodes('vue-compiler-sfc'),
    imports: astEdges('vue-compiler-sfc', 'references'),
    calls: astEdges('vue-compiler-sfc', 'calls'),
    references: astEdges('vue-compiler-sfc', 'references'),
    framework,
  }),
} as const satisfies Record<string, Record<CoverageCapability, ProducerDefinition>>);

type CatalogLanguage = keyof typeof COVERAGE_PRODUCER_CATALOG;

export interface CoveragePayload {
  languages: LanguageCapabilityCoverageV1[];
}

export interface BuildCoverageOptions {
  corpusPath?: string;
  /** Test seam; production always uses loadLspConfig. */
  loadConfig?: (rootPath: string) => LuxLspConfig;
}

/**
 * Derive language coverage from persisted production evidence. Candidates come only from
 * source-code knowledge metadata.language; counts come only from local canonical nodes/edges.
 */
export function buildCoverage(
  db: LuxDatabase,
  options: BuildCoverageOptions = {}
): CoveragePayload {
  const trust = inspectOverlayTrustState(db);
  const corpusPath = options.corpusPath || undefined;
  const config = corpusPath ? (options.loadConfig ?? loadLspConfig)(corpusPath) : null;
  const producerRuns = loadCoverageProducerRuns(db);
  const candidates = collectCandidates(db.getAllKnowledgeEntries(), corpusPath);
  const languageIds = new Set<string>([
    ...Object.keys(COVERAGE_PRODUCER_CATALOG),
    ...candidates.keys(),
  ]);

  return {
    languages: [...languageIds]
      .sort((left, right) => left.localeCompare(right))
      .map((languageId) => {
        const entries = candidates.get(languageId) ?? [];
        const output = collectCanonicalOutput(
          db,
          entries.map((entry) => entry.structuralPath)
        );
        return {
          schemaVersion: 1 as const,
          languageId,
          files: entries.length,
          symbolizedFiles: new Set(
            output.nodes.map((node) => node.file_path).filter((path): path is string => !!path)
          ).size,
          symbols: output.nodes.length,
          relatedSymbols: new Set(
            [...output.calls, ...output.references, ...output.framework].flatMap((edge) => [
              edge.source_node_id,
              edge.target_node_id,
            ])
          ).size,
          capabilities: Object.fromEntries(
            COVERAGE_CAPABILITIES.map((capability) => {
              const producer = producerFor(languageId, capability);
              const configured = entries.length > 0 && isConfigured(producer, config);
              const run = producerRun(producer, entries, trust, producerRuns);
              const counts = outputFor(producer.output, output);
              const capabilityCandidates =
                producer.runSignal === 'unsupported' && capability === 'framework'
                  ? output.framework.length
                  : entries.length;
              const documentedSubset =
                producer.documentedSubset === true ||
                (producer.runSignal === 'knowledge-lsp' &&
                  run.completedCandidates > 0 &&
                  run.completedCandidates < entries.length);
              return [
                capability,
                deriveCapability({
                  producer: producer.producer,
                  candidates: capabilityCandidates,
                  configured,
                  ran: run.ran,
                  failures: run.failures,
                  nodes: counts.nodes,
                  edges: counts.edges,
                  documentedSubset,
                }),
              ];
            })
          ) as Record<CoverageCapability, CapabilityEvidenceV1>,
        };
      }),
  };
}

interface Candidate {
  structuralPath: string;
  metadata: Record<string, unknown>;
}

function collectCandidates(
  entries: KnowledgeEntry[],
  corpusPath?: string
): Map<string, Candidate[]> {
  const result = new Map<string, Candidate[]>();
  for (const entry of entries) {
    if (entry.type !== 'source-code') continue;
    const metadata = parseObject(entry.metadata);
    const languageId = normalizeLanguage(metadata?.language);
    if (!metadata || !languageId) continue;
    const candidate = {
      metadata,
      structuralPath: toStructuralPath(entry.file_path, corpusPath),
    };
    const current = result.get(languageId);
    if (current) current.push(candidate);
    else result.set(languageId, [candidate]);
  }
  return result;
}

interface CanonicalOutput {
  nodes: StructuralNode[];
  calls: StructuralEdge[];
  references: StructuralEdge[];
  framework: StructuralEdge[];
}

function collectCanonicalOutput(db: LuxDatabase, filePaths: string[]): CanonicalOutput {
  const localNodes = db
    .getStructuralNodesForFilePaths(filePaths)
    .filter((node) => !LuxDatabase.isExternalNode(node));
  const nodes = localNodes.filter((node) => node.node_type === 'symbol');
  const nodeIds = new Set(localNodes.map((node) => node.id));
  const edgeMap = new Map<string, StructuralEdge>();
  for (const nodeId of nodeIds) {
    for (const edge of db.getStructuralEdgesForNode(nodeId)) {
      edgeMap.set(edge.id, edge);
    }
  }
  const edges = [...edgeMap.values()];
  return {
    nodes,
    calls: edges.filter((edge) => edge.edge_type === 'calls'),
    references: edges.filter((edge) => edge.edge_type === 'references'),
    framework: edges.filter(
      (edge) => edge.edge_type !== 'calls' && edge.edge_type !== 'references'
    ),
  };
}

function outputFor(
  kind: OutputKind,
  output: CanonicalOutput
): { nodes: number; edges: number } {
  if (kind === 'nodes') return { nodes: output.nodes.length, edges: 0 };
  if (kind === 'calls') return { nodes: 0, edges: output.calls.length };
  if (kind === 'references') return { nodes: 0, edges: output.references.length };
  if (kind === 'framework') return { nodes: 0, edges: output.framework.length };
  return { nodes: 0, edges: 0 };
}

function producerFor(
  languageId: string,
  capability: CoverageCapability
): ProducerDefinition {
  const catalog = COVERAGE_PRODUCER_CATALOG[languageId as CatalogLanguage];
  return catalog?.[capability] ?? unsupported;
}

function isConfigured(producer: ProducerDefinition, config: LuxLspConfig | null): boolean {
  if (producer.runSignal === 'unsupported' || !config) return false;
  if (producer.runSignal === 'overlay') return config.ast?.enabled ?? true;
  return (
    config.lsp.enabled &&
    config.lsp.enrichers.some(
      (entry) => entry.languageId === 'vue' && entry.enabled !== false
    )
  );
}

function producerRun(
  producer: ProducerDefinition,
  candidates: Candidate[],
  trust: ReturnType<typeof inspectOverlayTrustState>,
  producerRuns: ReturnType<typeof loadCoverageProducerRuns>
): { ran: boolean; failures: number; completedCandidates: number } {
  const persisted = producerRuns?.[producer.producer];
  if (persisted) {
    return {
      ran: persisted.status === 'success' || persisted.status === 'partial',
      failures: persisted.failures,
      completedCandidates: persisted.completedCandidates,
    };
  }
  if (producer.runSignal === 'overlay') {
    const ran =
      trust.source === 'persisted' &&
      trust.state !== null &&
      trust.state.mode !== 'content-only' &&
      (trust.state.sourceAction === 'index-rebuild' ||
        trust.state.sourceAction === 'index-refresh');
    return { ran, failures: 0, completedCandidates: ran ? candidates.length : 0 };
  }
  if (producer.runSignal === 'knowledge-lsp') {
    const completedCandidates = candidates.filter((candidate) => {
      const lsp = parseObject(candidate.metadata.lsp);
      return typeof lsp?.enrichedAt === 'number';
    }).length;
    return { ran: completedCandidates > 0, failures: 0, completedCandidates };
  }
  return { ran: false, failures: 0, completedCandidates: 0 };
}

function toStructuralPath(filePath: string, corpusPath?: string): string {
  const path = corpusPath && filePath.startsWith(corpusPath) ? relative(corpusPath, filePath) : filePath;
  return sep === '/' ? path : path.split(sep).join('/');
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return null;
  }
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const language = value.trim().toLowerCase();
  if (language === 'ts' || language === 'tsx') return 'typescript';
  if (language === 'js' || language === 'jsx') return 'javascript';
  return language;
}
