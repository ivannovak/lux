import { relative, sep } from 'node:path';

import type { StructuralNode } from '../../../../db/types.js';
import type { SourceDiagnosticV1 } from '../../../contracts/program.js';
import { programEdgeId } from '../../../identity/program-identity.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../types.js';
import {
  extractInertiaFacts,
  type InertiaPageFactV1,
  type InertiaFactExtractionV1,
} from './inertia-facts.js';
import {
  buildInertiaPageRegistry,
  type InertiaFrameworkConfigV1,
  type InertiaPageRegistryV1,
} from './inertia-pages.js';

export interface InertiaAssociationResolverOptionsV1 {
  config?: InertiaFrameworkConfigV1;
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void;
  now?: () => number;
}

/** Resolve literal Laravel Inertia responses to canonical, existing Vue components. */
export class InertiaAssociationResolver implements AssociationResolver {
  readonly name = 'laravel-inertia';

  constructor(private readonly options: InertiaAssociationResolverOptionsV1 = {}) {}

  supports(context: AssociationContext): boolean {
    return Boolean(
      context.programAnalysis?.project &&
      context.sharedExtractions &&
      context.entries.some((entry) => entry.languageId === 'php') &&
      context.nodes.some((node) => node.language_id === 'vue')
    );
  }

  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    if (!context.programAnalysis?.project || !context.sharedExtractions) {
      return Promise.resolve([]);
    }
    const registry = buildInertiaPageRegistry({
      project: context.programAnalysis.project,
      sources: context.entries.flatMap((entry) => {
        const content = entry.metadata?.content;
        return typeof content === 'string' && isEcmaScript(entry.filePath, entry.languageId)
          ? [{ filePath: relativePath(entry.filePath, context.rootPath), content }]
          : [];
      }),
      config: this.options.config,
      onDiagnostic: this.options.onDiagnostic,
    });
    const existingNodes = new Map(context.nodes.map((node) => [node.id, node]));
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const edges = new Map<string, StructuralRelationEdge>();

    for (const entry of context.entries) {
      if (entry.languageId !== 'php') continue;
      const filePath = relativePath(entry.filePath, context.rootPath);
      const content = entry.metadata?.content;
      const extraction = context.sharedExtractions.get(filePath);
      if (typeof content !== 'string' || !extraction) continue;
      const facts = extractInertiaFacts({
        filePath,
        content,
        extraction,
        collisions: context.symbolCollisions,
      });
      this.reportDiagnostics(facts);
      for (const fact of facts.pages) {
        const edge = resolveInertiaPageFact(fact, registry, existingNodes, this.name, now);
        if (edge) edges.set(edge.id, edge);
      }
    }

    return Promise.resolve(
      [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  private reportDiagnostics(facts: InertiaFactExtractionV1): void {
    for (const diagnostic of facts.diagnostics) this.options.onDiagnostic?.(diagnostic);
  }
}

/** Resolve one fact; exported as a narrow deterministic leaf seam for tests/integration. */
export function resolveInertiaPageFact(
  fact: InertiaPageFactV1,
  registry: InertiaPageRegistryV1,
  existingNodes: ReadonlyMap<string, StructuralNode>,
  producer = 'laravel-inertia',
  extractedAt = Math.floor(Date.now() / 1000)
): StructuralRelationEdge | undefined {
  const registration = registry.resolve(fact.pageName);
  if (!registration) return undefined;
  const source = existingNodes.get(fact.sourceNodeId);
  const target = existingNodes.get(registration.componentId);
  if (!isPhpCallable(source) || !isVueComponent(target, registration.componentFile))
    return undefined;

  const id = programEdgeId(
    'hydrates_component',
    fact.sourceNodeId,
    registration.componentId,
    producer
  );
  return {
    id,
    edgeType: 'hydrates_component',
    sourceNodeId: fact.sourceNodeId,
    targetNodeId: registration.componentId,
    sourceLanguage: 'php',
    targetLanguage: 'vue',
    confidence: 0.9,
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver: producer,
      evidenceKind: 'inertia-static-page-registry',
      evidenceLocations: mergeLocations([fact.location, ...registration.evidenceLocations]),
      extractedAt,
    },
  };
}

function isPhpCallable(node: StructuralNode | undefined): boolean {
  return Boolean(
    node &&
    node.node_type === 'symbol' &&
    node.language_id === 'php' &&
    (node.symbol_kind === 'Method' || node.symbol_kind === 'Function')
  );
}

function isVueComponent(node: StructuralNode | undefined, componentFile: string): boolean {
  return Boolean(
    node &&
    node.node_type === 'symbol' &&
    node.language_id === 'vue' &&
    node.file_path === componentFile
  );
}

function mergeLocations(
  locations: StructuralRelationEdge['provenance']['evidenceLocations']
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  return [
    ...new Map(
      locations.map((item) => [`${item.filePath}:${item.line ?? ''}:${item.note ?? ''}`, item])
    ).values(),
  ].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || (left.line ?? 0) - (right.line ?? 0)
  );
}

function relativePath(filePath: string, rootPath: string): string {
  const value = relative(rootPath, filePath);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`)
    ? value.split(sep).join('/')
    : filePath.split(sep).join('/');
}

function isEcmaScript(filePath: string, languageId?: string): boolean {
  return (
    languageId === 'javascript' ||
    languageId === 'typescript' ||
    /\.(?:[cm]?[jt]sx?)$/u.test(filePath)
  );
}
