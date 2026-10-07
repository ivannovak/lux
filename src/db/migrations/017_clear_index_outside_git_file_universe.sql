-- src/db/migrations/017_clear_index_outside_git_file_universe.sql
--
-- lux-notice-if-rows(knowledge_entries): this index may hold files that git ignores or does not track, or credential files, which Lux no longer indexes. Its contents were cleared and must be rebuilt: run `lux index rebuild`, or let the next `lux index sync` rebuild it in full.
--
-- Up to schema 16, a rebuild walked the working tree by its include globs, so an index could hold
-- files git ignores (a Composer auth.json with registry credentials, scratch files), untracked
-- files, and files under the on-disk case of a directory git tracks under another case. From 17 on,
-- the file universe is git's (src/scanner/file-universe.ts): tracked files, under the paths
-- `git ls-files` prints, less a built-in credential deny list.
--
-- The old rows are cleared rather than filtered. Which of them git ignored when they were indexed
-- is not recorded, and a row whose content is a credential must not survive in the full-text
-- index until some later sync happens to touch its path. The index is derived state, so clearing it
-- costs one rebuild.
--
-- Everything a rebuild derives is cleared together, so no table is left describing files whose
-- content rows are gone. index_metadata goes too: with no last_indexed_commit, `lux index sync`
-- rebuilds in full instead of applying a diff to an empty index. The usage log (events) is kept.

DELETE FROM knowledge_entries;
DELETE FROM module_dependencies;
DELETE FROM edge_evidence;
DELETE FROM structural_edges;
DELETE FROM structural_nodes;
DELETE FROM structural_node_texts;
DELETE FROM structural_node_fts;
DELETE FROM structural_node_embeddings;
DELETE FROM operational_contracts;
DELETE FROM operational_edges;
DELETE FROM operational_handlers;
DELETE FROM operational_boundaries;
DELETE FROM index_metadata;
