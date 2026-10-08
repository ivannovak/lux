import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import Parser from 'web-tree-sitter';
import { initTreeSitterRuntime } from '../ast/tree-sitter-runtime.js';
import { confinedRead } from '../adapters/path-policy.js';
import { DEFAULT_PARSER_LIMITS } from '../adapters/types.js';
import { ParseBudgetV1 } from '../adapters/infrastructure-types.js';
import type { DeclarationFactV1 } from '../contracts/program.js';
import type { ImportBindingV1, CallSiteV1 } from '../languages/contracts.js';
import type { StructuralRelationEdge } from '../associations/types.js';
import type {
  GoProjectV1,
  LanguageFileFactsV1,
  LanguageNodeV1,
  LanguageResolutionV1,
} from '../languages/contracts.js';
import { goPackageId, goSymbolId } from '../identity/program-identity.js';
import { frameworkEdge } from '../react/edge-factory.js';
import { discoverGoProject, goImportToPackage } from './project.js';
const require = createRequire(import.meta.url);
let lang: Promise<Parser.Language> | undefined;
async function grammar() {
  await initTreeSitterRuntime();
  return (lang ??= Parser.Language.load(
    join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out/tree-sitter-go.wasm')
  ));
}
export class GoDeterministicAdapter {
  readonly languageId = 'go' as const;
  discover(rootPath: string, allowedRoots: readonly string[]) {
    return discoverGoProject({
      corpusRoot: rootPath,
      allowedRoots,
      sourceRoots: ['.'],
      maxFiles: 20000,
    });
  }
  async extract(project: GoProjectV1) {
    const l = await grammar(),
      out: LanguageFileFactsV1[] = [];
    for (const filePath of project.files) {
      const bytes = confinedRead({
          corpusRoot: project.corpusRoot,
          allowedRoots: project.allowedRoots,
          filePath,
          limits: DEFAULT_PARSER_LIMITS,
        }).bytes,
        source = new TextDecoder('utf8', { fatal: true }).decode(bytes),
        p = new Parser();
      p.setLanguage(l);
      const tree = p.parse(source),
        pkg = /\bpackage\s+(\w+)/u.exec(source)?.[1] ?? '',
        declarations: DeclarationFactV1[] = [],
        imports: ImportBindingV1[] = [],
        calls: CallSiteV1[] = [];
      const budget = new ParseBudgetV1(DEFAULT_PARSER_LIMITS);
      walk(tree.rootNode, (n, depth) => {
        budget.visit(depth);
        if (['function_declaration', 'method_declaration', 'type_declaration'].includes(n.type)) {
          const name =
            n.childForFieldName('name')?.text ??
            n.namedChildren.find((c) => c.type === 'type_spec')?.childForFieldName('name')?.text;
          if (name)
            declarations.push({
              localId: name,
              kind:
                n.type === 'type_declaration'
                  ? 'type'
                  : n.type === 'method_declaration'
                    ? 'method'
                    : 'function',
              name,
              location: loc(filePath, n),
            });
        }
        if (n.type === 'import_spec') {
          const path = n.childForFieldName('path')?.text.replace(/^"|"$/gu, '');
          if (path) {
            const aliasNode = n.namedChildren.find(
              (child) =>
                child.type === 'package_identifier' ||
                child.type === 'dot' ||
                child.type === 'blank_identifier'
            );
            const alias = aliasNode?.text;
            imports.push({
              local: alias && alias !== '_' && alias !== '.' ? alias : path.split('/').at(-1)!,
              imported: '*',
              module: path,
              kind: alias === '_' ? 'side-effect' : alias === '.' ? 'named' : 'namespace',
              location: loc(filePath, n),
            });
          }
        }
        if (n.type === 'call_expression') {
          const f = n.childForFieldName('function');
          if (f) {
            budget.reference();
            calls.push({
              fromLocalId: owner(tree.rootNode, n.startIndex),
              rawCallee: f.text,
              member: f.text.split('.').at(-1)!,
              location: loc(filePath, n),
            });
          }
        }
      });
      out.push({
        schemaVersion: 1,
        languageId: 'go',
        filePath,
        packageOrModule: pkg,
        declarations,
        references: [],
        imports,
        calls,
        diagnostics: tree.rootNode.hasError
          ? [
              {
                code: 'go-parse-error',
                message: 'Malformed Go.',
                location: loc(filePath, tree.rootNode),
              },
            ]
          : [],
        dependencies: imports.map((item) => item.module),
        generated: /^\/\/ Code generated .* DO NOT EDIT\./mu.test(source),
        conditional: /^\/\/go:build/mu.test(source),
        test: filePath.endsWith('_test.go'),
      });
    }
    return out;
  }
  resolve(
    project: GoProjectV1,
    facts: readonly LanguageFileFactsV1[]
  ): Promise<LanguageResolutionV1> {
    const nodes: LanguageNodeV1[] = [],
      edges: StructuralRelationEdge[] = [];
    const by = new Map<string, string>();
    for (const [path, files] of project.packages) {
      const id = goPackageId(project.modulePath, path);
      nodes.push({
        id,
        nodeType: 'symbol',
        languageId: 'go',
        symbolName: path,
        symbolKind: 'package',
        qualifiedName: `${project.modulePath}/${path}`,
        metadata: { files },
      });
      for (const f of facts.filter((x) => files.includes(x.filePath)))
        for (const d of f.declarations) {
          const sid = goSymbolId(project.modulePath, path, d.name);
          by.set(`${f.filePath}\0${d.name}`, sid);
          nodes.push({
            id: sid,
            nodeType: 'symbol',
            languageId: 'go',
            filePath: f.filePath,
            symbolName: d.name,
            symbolKind: d.kind,
            qualifiedName: `${project.modulePath}/${path}.${d.name}`,
            metadata: {},
          });
        }
    }
    for (const f of facts) {
      if (f.generated || f.conditional || f.test || f.diagnostics.length > 0) continue;
      const dir = posix.dirname(f.filePath) === '.' ? '.' : posix.dirname(f.filePath),
        source = goPackageId(project.modulePath, dir);
      for (const i of f.imports) {
        const r = goImportToPackage(i.module, project),
          target =
            r.status === 'first-party'
              ? goPackageId(project.modulePath, r.packagePath)
              : goPackageId(i.module, '.');
        edges.push(
          frameworkEdge({
            resolver: 'go-deterministic',
            edgeType: 'references',
            sourceNodeId: source,
            targetNodeId: target,
            sourceLanguage: 'go',
            targetLanguage: 'go',
            confidence: r.status === 'first-party' ? 0.85 : 0.6,
            confidenceClass: r.status === 'first-party' ? 'artifact-backed' : 'framework-inferred',
            evidenceKind: 'go-import',
            locations: [i.location],
          })
        );
        if (r.status === 'external')
          nodes.push({
            id: target,
            nodeType: 'symbol',
            languageId: 'go',
            symbolName: i.module,
            symbolKind: 'package',
            qualifiedName: i.module,
            metadata: { external: true },
          });
      }
      for (const c of f.calls) {
        const target = by.get(`${f.filePath}\0${c.member}`),
          from = by.get(`${f.filePath}\0${c.fromLocalId}`);
        if (target && from && target !== from)
          edges.push(
            frameworkEdge({
              resolver: 'go-deterministic',
              edgeType: 'calls',
              sourceNodeId: from,
              targetNodeId: target,
              sourceLanguage: 'go',
              targetLanguage: 'go',
              confidence: 0.6,
              confidenceClass: 'framework-inferred',
              evidenceKind: 'go-same-file-call',
              locations: [c.location],
            })
          );
      }
    }
    return Promise.resolve({
      facts,
      nodes,
      edges,
      diagnostics: facts.flatMap((f) => f.diagnostics),
      producerRan: {
        'go-deterministic': true,
        gopls: false,
        'go-frameworks': false,
        'python-deterministic': false,
        pyright: false,
        'python-frameworks': false,
      },
    });
  }
  toSourceFacts(f: LanguageFileFactsV1) {
    return {
      schemaVersion: 1,
      languageId: 'go',
      filePath: f.filePath,
      declarations: f.declarations,
      references: f.references,
      diagnostics: f.diagnostics,
    };
  }
}
function walk(n: Parser.SyntaxNode, v: (n: Parser.SyntaxNode, depth: number) => void, depth = 0) {
  v(n, depth);
  for (const child of n.namedChildren) walk(child, v, depth + 1);
}
function loc(filePath: string, n: Parser.SyntaxNode) {
  return { filePath, line: n.startPosition.row + 1, column: n.startPosition.column };
}
function owner(root: Parser.SyntaxNode, byte: number) {
  const n = root
    .descendantsOfType(['function_declaration', 'method_declaration'])
    .filter((x) => x.startIndex <= byte && byte <= x.endIndex)
    .sort((a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex))[0];
  return n?.childForFieldName('name')?.text ?? `file:${root.text.length}`;
}
