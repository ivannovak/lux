import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';
import { initTreeSitterRuntime } from '../../ast/tree-sitter-runtime.js';
import type { AdapterInputV1 } from '../types.js';
import type {
  DeclarationFactV1,
  ReferenceFactV1,
  SourceDiagnosticV1,
} from '../../contracts/program.js';
import type {
  ArtifactAdapterOutputV1,
  InfrastructureFactV1,
  HclBlockFactV1,
  HclAttributeFactV1,
  HclTraversalFactV1,
  HclBlockKindV1,
} from '../infrastructure-types.js';
import { ParseBudgetV1 } from '../infrastructure-types.js';
import { confinedRead } from '../path-policy.js';
import { hclRange, hclString } from './normalize.js';
let language: Promise<Parser.Language> | undefined;
async function grammar() {
  await initTreeSitterRuntime();
  const asset = new URL(`./tree-sitter-hcl.wasm`, import.meta.url);
  return (language ??= Parser.Language.load(fileURLToPath(asset)));
}
export class HclArtifactAdapter {
  readonly id = 'hcl-tree-sitter';
  readonly languages = ['hcl'];
  async extract(input: AdapterInputV1): Promise<ArtifactAdapterOutputV1<InfrastructureFactV1>> {
    const read = confinedRead(input),
      source = new TextDecoder('utf8', { fatal: true }).decode(read.bytes);
    const hclGrammar = await grammar();
    const parser = new Parser();
    parser.setLanguage(hclGrammar);
    const tree = parser.parse(source),
      facts: InfrastructureFactV1[] = [],
      declarations: DeclarationFactV1[] = [],
      references: ReferenceFactV1[] = [],
      diagnostics: SourceDiagnosticV1[] = [],
      dependencies: string[] = [],
      budget = new ParseBudgetV1(input.limits),
      filePath = input.filePath.replaceAll('\\', '/');
    const walk = (node: Parser.SyntaxNode, depth: number, owner?: string) => {
      budget.visit(depth);
      if (node.isError || node.isMissing)
        diagnostics.push({
          code: 'parse-error',
          message: 'Malformed HCL syntax.',
          location: hclRange(filePath, node),
        });
      let next = owner;
      if (node.type === 'block') {
        const names = node.namedChildren.filter(
            (x) => x.type === 'identifier' || x.type === 'string_lit'
          ),
          kind = names[0]?.text ?? 'unknown',
          labels = names.slice(1).map((x) => hclString(x) ?? x.text),
          localId = `${kind}:${labels.join('.')}:${node.startIndex}`,
          range = hclRange(filePath, node),
          fact: HclBlockFactV1 = {
            schemaVersion: 1,
            family: 'hcl-block',
            localId,
            filePath,
            range,
            blockKind: hclBlockKind(kind),
            labels,
          };
        facts.push(fact);
        declarations.push({ localId, kind, name: labels.join('.') || kind, location: range });
        if (kind === 'unknown')
          diagnostics.push({
            code: 'hcl-unknown-block',
            message: `Unknown HCL block ${kind}.`,
            location: range,
          });
        next = localId;
      }
      if (node.type === 'attribute' && next) {
        const name = node.namedChildren.find((x) => x.type === 'identifier')?.text ?? '',
          expr = node.namedChildren.find((x) => x.type === 'expression'),
          range = hclRange(filePath, node),
          staticValue = [
            'source',
            'alias',
            'backend',
            'runtime',
            'handler',
            'filename',
            'source_dir',
            'source_file',
            'output_path',
            'key',
          ].includes(name)
            ? hclString(expr?.descendantsOfType('string_lit')[0])
            : undefined;
        const f: HclAttributeFactV1 = {
          schemaVersion: 1,
          family: 'hcl-attribute',
          localId: `${next}:attr:${name}:${node.startIndex}`,
          filePath,
          range,
          ownerLocalId: next,
          name,
          expressionRange: expr ? hclRange(filePath, expr) : range,
          hasInterpolation: node.text.includes('${'),
          ...(staticValue ? { staticString: staticValue } : {}),
        };
        facts.push(f);
        if (name === 'source' && staticValue?.startsWith('./')) {
          const displayPath = filePath.startsWith(input.corpusRoot + '/')
            ? filePath.slice(input.corpusRoot.length + 1)
            : filePath;
          dependencies.push(posix.normalize(posix.join(posix.dirname(displayPath), staticValue)));
        }
      }
      if ((node.type === 'variable_expr' || node.type === 'get_attr') && next) {
        const text = node.parent?.type === 'expression' ? node.parent.text : node.text;
        if (/^(?:var|local|module|data|provider|[A-Za-z_]\w*)\./u.test(text)) {
          budget.reference();
          const parts = text.replace(/\[[^\]]*\]/gu, '').split('.'),
            base = parts[0] === 'data' ? parts.slice(0, 3).join('.') : parts.slice(0, 2).join('.'),
            range = hclRange(filePath, node.parent?.type === 'expression' ? node.parent : node),
            f: HclTraversalFactV1 = {
              schemaVersion: 1,
              family: 'hcl-traversal',
              localId: `${next}:ref:${node.startIndex}`,
              filePath,
              range,
              ownerLocalId: next,
              root: parts[0],
              segments: parts.slice(1).map((name) => ({ kind: 'attribute' as const, name })),
              baseAddress: base,
              fullyStatic: !text.includes('['),
            };
          facts.push(f);
          references.push({
            fromLocalId: next,
            kind: 'reference',
            rawTarget: base,
            location: range,
          });
        }
      }
      for (const c of node.namedChildren) walk(c, depth + 1, next);
    };
    walk(tree.rootNode, 0);
    if (tree.rootNode.hasError && !diagnostics.some((item) => item.code === 'parse-error')) {
      diagnostics.push({
        code: 'parse-error',
        message: 'Malformed HCL syntax.',
        location: hclRange(filePath, tree.rootNode),
      });
    }
    return {
      facts: {
        schemaVersion: 1,
        languageId: 'hcl',
        filePath,
        declarations,
        references,
        diagnostics,
      },
      artifactFacts: facts,
      dependencies: [...new Set(dependencies)].sort(),
      diagnostics,
    };
  }
}

function hclBlockKind(value: string): HclBlockKindV1 {
  const known: readonly HclBlockKindV1[] = [
    'terraform',
    'provider',
    'resource',
    'data',
    'variable',
    'locals',
    'output',
    'module',
    'moved',
    'import',
    'check',
  ];
  return known.includes(value as HclBlockKindV1) ? (value as HclBlockKindV1) : 'unknown';
}
