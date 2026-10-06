// Which symbols a change modified (issue #41), as opposed to which symbols live in a changed file.
//
// The index stores no line ranges, and it may sit at either end of the diff (at the base by
// default, at the head when a caller indexed the commit first), so both sides are read here: each
// changed file is parsed at the base ref and at the head, and a symbol is changed when its own
// code differs between the two.
// "Own" means the lines of its declaration and body that belong to no nested symbol: a class
// whose method was edited is not itself changed, a class whose property was edited is. "Code"
// means what is left after dropping blank lines, indentation and comment-only lines, so a
// docblock or whitespace edit changes no symbol.
// That is the set of symbols whose range the diff's changed lines intersect on either side, less
// the ones where the intersecting lines changed no code. It is computed from the two sources
// rather than from diff hunks because a hunk boundary is the diff algorithm's choice: for a
// method moved past two others, a line diff may as well report the two others as moved.
//
// What each outcome is called:
//   modified    declared on both sides, own code differs
//   added       declared on the head side only
//   removed     declared on the base side only
//   moved       same code on both sides, in a different place among its siblings
//   file-level  the file could not be parsed into symbols (no grammar for it, or unreadable), so
//               every symbol the index holds for it is listed and none can be ruled out

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LuxDatabase } from '../../db/index.js';
import { readFileAtRef } from '../git.js';
import { extractSource, getGrammars, langForFile, type AstLang } from '../ast/extract.js';
import { astSymbolIdentity } from '../ast/symbols.js';
import { fileNodeId } from '../associations/types.js';
import { compareCodeUnits } from '../scan-order.js';
import { isIndexablePath } from './change-set.js';
import { fileQualifiedId } from '../identity/file-qualified-id.js';
import type { DeltaChangeSet, DeltaFile, SymbolChange, TouchPrecision } from './types.js';

export interface ChangedSymbols {
  /** One entry per changed symbol, sorted by id then path. */
  changes: SymbolChange[];
  precision: TouchPrecision;
  /**
   * Where the downstream walk starts: the changed symbols, and the file node of a file whose
   * code changed outside any symbol. The walk itself crosses from a method to its class
   * (delta/downstream.ts).
   */
  seeds: string[];
}

/** One declaration on one side of the diff. */
interface Declared {
  id: string;
  /** Normalized own code: the declaration's lines minus nested declarations, comments, blanks. */
  code: string;
  /** The id of the declaration this one is nested in, for sibling order ('' at file level). */
  parent: string;
}

interface Side {
  declared: Map<string, Declared>;
  /** Normalized code of the lines that belong to no declaration. */
  outside: string;
}

export async function resolveChangedSymbols(
  db: LuxDatabase,
  corpusPath: string,
  changeSet: DeltaChangeSet,
  committedOnly: boolean
): Promise<ChangedSymbols> {
  const changes: SymbolChange[] = [];
  const precision: TouchPrecision = {
    fileLevelOnly: [],
    renamedOnly: [],
    cosmeticOnly: [],
    changedOutsideSymbols: [],
  };
  const seeds = new Set<string>();
  if (changeSet.files.length === 0) return { changes, precision, seeds: [] };

  const grammars = await getGrammars();

  for (const file of changeSet.files) {
    const basePath = file.renamedFrom ?? file.path;
    const baseText =
      file.status === 'added' || file.status === 'untracked'
        ? null
        : readFileAtRef(corpusPath, changeSet.base.ref, basePath);
    const headText = file.status === 'deleted' ? null : readHead(corpusPath, file, committedOnly);

    if (baseText !== null && headText !== null && baseText === headText) {
      // Same content on both sides: a pure rename changes no symbol. (A file that reached the
      // change set without a content difference, e.g. from overlay staleness marks, is unknown.)
      if (file.status === 'renamed') precision.renamedOnly.push(file.path);
      else fileLevel(db, file, changes, precision, seeds);
      continue;
    }

    const lang = file.path.endsWith('.blade.php') ? null : langForFile(file.path);
    const sides =
      lang && (baseText !== null || headText !== null)
        ? parseSides(grammars, lang, file, baseText, headText)
        : null;
    if (!sides) {
      fileLevel(db, file, changes, precision, seeds);
      continue;
    }

    const before = changes.length;
    const moved = movedIds(sides.base.declared, sides.head.declared);
    for (const id of new Set([...sides.base.declared.keys(), ...sides.head.declared.keys()])) {
      const base = sides.base.declared.get(id);
      const head = sides.head.declared.get(id);
      const change = classify(base, head, moved.has(id));
      if (!change) continue;
      const stored = storedId(db, id, head ? file.path : basePath);
      changes.push({ id: stored, change, path: file.path });
      seeds.add(stored);
    }

    const outsideChanged = sides.base.outside !== sides.head.outside;
    if (outsideChanged) {
      precision.changedOutsideSymbols.push(file.path);
      seeds.add(fileNodeId(file.path));
      seeds.add(fileNodeId(basePath));
    }
    if (changes.length === before && !outsideChanged) precision.cosmeticOnly.push(file.path);
  }

  changes.sort((a, b) => compareCodeUnits(a.id, b.id) || compareCodeUnits(a.path, b.path));
  for (const list of Object.values(precision) as string[][]) list.sort(compareCodeUnits);
  return { changes, precision, seeds: [...seeds] };
}

function classify(
  base: Declared | undefined,
  head: Declared | undefined,
  moved: boolean
): SymbolChange['change'] | null {
  if (!base) return 'added';
  if (!head) return 'removed';
  if (base.code !== head.code) return 'modified';
  return moved ? 'moved' : null;
}

/**
 * The declarations present on both sides whose place among their siblings changed. Per parent,
 * the ids common to both sides are compared in order; the ones outside a longest common
 * subsequence are the fewest that must have moved to turn one order into the other.
 */
function movedIds(base: Map<string, Declared>, head: Map<string, Declared>): Set<string> {
  const orderOf = (side: Map<string, Declared>, other: Map<string, Declared>) => {
    const byParent = new Map<string, string[]>();
    for (const declared of side.values()) {
      if (!other.has(declared.id)) continue;
      byParent.set(declared.parent, [...(byParent.get(declared.parent) ?? []), declared.id]);
    }
    return byParent;
  };
  const baseOrder = orderOf(base, head);
  const headOrder = orderOf(head, base);
  const moved = new Set<string>();
  for (const [parent, before] of baseOrder) {
    const after = (headOrder.get(parent) ?? []).filter((id) => before.includes(id));
    const kept = new Set(
      longestCommonSubsequence(
        before.filter((id) => after.includes(id)),
        after
      )
    );
    for (const id of after) if (!kept.has(id)) moved.add(id);
  }
  return moved;
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const common: string[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      common.push(a[i]);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return common;
}

/** The symbols of a file that cannot be told apart: all of them, marked as file-level. */
function fileLevel(
  db: LuxDatabase,
  file: DeltaFile,
  changes: SymbolChange[],
  precision: TouchPrecision,
  seeds: Set<string>
): void {
  const paths = [...new Set([file.path, file.renamedFrom ?? file.path])];
  const symbols = db
    .getStructuralNodesForFilePaths(paths)
    .filter((node) => node.node_type === 'symbol');
  // A file that is not source and holds no indexed symbol (a workflow, a CSV) has nothing to
  // attribute; naming it would only pad the list.
  if (symbols.length === 0 && !isIndexablePath(file.path)) return;
  precision.fileLevelOnly.push(file.path);
  for (const node of symbols) {
    changes.push({ id: node.id, change: 'file-level', path: file.path });
    seeds.add(node.id);
  }
  for (const path of paths) seeds.add(fileNodeId(path));
}

function readHead(corpusPath: string, file: DeltaFile, committedOnly: boolean): string | null {
  if (committedOnly) return readFileAtRef(corpusPath, 'HEAD', file.path);
  const absolute = join(corpusPath, file.path);
  try {
    return existsSync(absolute) ? readFileSync(absolute, 'utf-8') : null;
  } catch {
    // lux-intentional-swallow: an unreadable working-tree file is treated as absent; with no base either, the file is reported file-level.
    return null;
  }
}

/** The id a declaration is stored under: file-qualified when the index holds it that way. */
function storedId(db: LuxDatabase, id: string, path: string): string {
  if (db.getStructuralNode(id)) return id;
  const qualified = fileQualifiedId(id, path);
  return db.getStructuralNode(qualified) ? qualified : id;
}

function parseSides(
  grammars: Awaited<ReturnType<typeof getGrammars>>,
  lang: AstLang,
  file: DeltaFile,
  baseText: string | null,
  headText: string | null
): { base: Side; head: Side } | null {
  try {
    // Ids are built with the head path on both sides, so the two sides of a renamed file pair up
    // even where the path is part of the id.
    return {
      base: parseSide(grammars, lang, file.path, baseText),
      head: parseSide(grammars, lang, file.path, headText),
    };
  } catch {
    // lux-intentional-swallow: a file the grammar cannot parse is reported file-level by the caller, which names it in precision.fileLevelOnly.
    return null;
  }
}

function parseSide(
  grammars: Awaited<ReturnType<typeof getGrammars>>,
  lang: AstLang,
  relPath: string,
  text: string | null
): Side {
  if (text === null) return { declared: new Map(), outside: '' };
  const { extraction } = extractSource(grammars, text, relPath, lang);
  const lines = text.split('\n');
  const defs = extraction.nodes;
  const ids = defs.map((def) => astSymbolIdentity(relPath, def, lang, extraction.namespace).id);

  // The innermost declaration that owns each line (1-based); undefined outside every declaration.
  // Wider declarations are laid down first, so a nested one overwrites its lines.
  const owner: Array<number | undefined> = new Array<number | undefined>(lines.length + 2);
  const parent: Array<number | undefined> = defs.map(() => undefined);
  const widestFirst = defs
    .map((def, index) => ({ index, size: def.range.endLine - def.range.startLine }))
    .sort((a, b) => b.size - a.size || a.index - b.index);
  for (const { index } of widestFirst) {
    parent[index] = owner[defs[index].range.startLine];
    for (let line = defs[index].range.startLine; line <= defs[index].range.endLine; line++) {
      owner[line] = index;
    }
  }

  const own: string[][] = defs.map(() => []);
  const outside: string[] = [];
  for (let line = 1; line <= lines.length; line++) {
    const at = owner[line];
    (at === undefined ? outside : own[at]).push(lines[line - 1]);
  }

  const declared = new Map<string, Declared>();
  defs.forEach((_def, index) => {
    const id = ids[index];
    if (declared.has(id)) return; // a name declared twice in one file: the first stands for it
    declared.set(id, {
      id,
      code: codeOf(own[index], lang),
      parent: parent[index] === undefined ? '' : ids[parent[index]],
    });
  });
  return { declared, outside: codeOf(outside, lang) };
}

/**
 * The code of some lines: each line trimmed, with blank lines and comment-only lines dropped.
 * A `#[...]` line in PHP is an attribute and a `#name` line in JavaScript a private member, so
 * `#` starts a comment only in PHP and only when no `[` follows.
 */
function codeOf(lines: string[], lang: AstLang): string {
  const code: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('//')) continue;
    if (lang === 'php' && line.startsWith('#') && !line.startsWith('#[')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      else if (!line.endsWith('*/')) code.push(line); // a comment followed by code on one line
      continue;
    }
    code.push(line);
  }
  return code.join('\n');
}
