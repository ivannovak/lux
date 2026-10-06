// The file-qualified form of an id that two or more files declare.
//
// Some ids name a thing by what the framework calls it, with no file in them: a PHP symbol by its
// FQCN, an HTTP surface by method and path, an Artisan command by its name. Two files can then
// declare the same id, and one row cannot hold both declarations. The rule, shared by every such
// id family:
//   - an id declared by exactly one file keeps its form unchanged;
//   - an id declared by two or more files is file-qualified for every one of them (none keeps the
//     bare id) as `<bare id>#file:<repo-relative path>`.
// The path is the declaring file's, so the stored rows do not depend on processing order, and
// every field of a row comes from the one declaration its id names.

/** Joins a colliding id to the repo-relative path of the file that declares it. */
const FILE_QUALIFIER = '#file:';

/** One file's claim on an id. */
export interface IdDeclaration {
  id: string;
  relPath: string;
}

/** The bare ids that more than one distinct file declares, each with its declaring files, sorted. */
export function idsDeclaredByManyFiles(
  declarations: Iterable<IdDeclaration>
): Map<string, string[]> {
  const files = new Map<string, Set<string>>();
  for (const { id, relPath } of declarations) {
    const bare = bareId(id);
    const seen = files.get(bare);
    if (seen) seen.add(relPath);
    else files.set(bare, new Set([relPath]));
  }
  const colliding = new Map<string, string[]>();
  for (const bare of [...files.keys()].sort()) {
    const declaring = files.get(bare)!;
    if (declaring.size > 1) colliding.set(bare, [...declaring].sort());
  }
  return colliding;
}

/** The id one file's declaration of a shared id is stored under. */
export function fileQualifiedId(id: string, relPath: string): string {
  return `${id}${FILE_QUALIFIER}${relPath}`;
}

/** The id without its file qualifier (unchanged when it has none). */
export function bareId(id: string): string {
  const at = id.indexOf(FILE_QUALIFIER);
  return at === -1 ? id : id.slice(0, at);
}

/** True for a file-qualified id: it names one file's declaration, never a shared one. */
export function isFileQualifiedId(id: string): boolean {
  return id.includes(FILE_QUALIFIER);
}
