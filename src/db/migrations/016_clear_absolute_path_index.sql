-- src/db/migrations/016_clear_absolute_path_index.sql
--
-- lux-notice-if-rows(knowledge_entries): this index stored absolute file paths, which Lux no longer reads. Its contents were cleared and must be rebuilt: run `lux index rebuild`, or let the next `lux index sync` rebuild it in full.
--
-- Up to schema 15, knowledge_entries.file_path, module_dependencies.sample_files and the stored
-- overlay trust state held absolute paths. From 16 on, every stored path is relative to the corpus
-- root (src/db/stored-path.ts), so an index does not depend on where its repository is checked out.
--
-- The old rows are cleared rather than rewritten. SQL cannot prove what to strip from every row: an
-- index built without an overlay recorded no root, an index that was moved or shipped recorded the
-- wrong one, and the same directory can be spelled two ways (/var and /private/var). A rewrite that
-- misses some rows leaves absolute and relative paths side by side, read as if they were one form.
-- The index is derived state, so clearing it costs one rebuild and cannot leave it mixed.
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
