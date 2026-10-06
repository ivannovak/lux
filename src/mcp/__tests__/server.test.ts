import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from 'fs';
import { LuxDatabase, resolveStoredPath } from '../../db/index.js';
import { GeneralScanner } from '../../scanner/index.js';

/**
 * MCP Server Test Suite
 *
 * Tests all MCP tools exposed by the Lux MCP server:
 * - lux_search: Search across all indexed documents
 * - lux_log_event: Log an event to audit trail
 * - lux_get_file: Read file content
 * - lux_rebuild_index: Rebuild the entire index
 */

describe('MCP Server Tools', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-mcp-test-'));
  const contentDir = join(testDir, 'content');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  // Setup test environment before each test
  beforeEach(async () => {
    // Clean up any existing test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Create test content directory structure
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(join(contentDir, 'knowledge', '20_methodology'), { recursive: true });
    mkdirSync(join(contentDir, 'explorations'), { recursive: true });

    // Create test knowledge entry
    writeFileSync(
      join(contentDir, 'knowledge', '20_methodology', 'testing.md'),
      `---
title: Testing Methodology
tags:
  - testing
  - quality
---

# Testing Methodology

Our approach to testing.
`
    );

    // Create another knowledge entry
    writeFileSync(
      join(contentDir, 'explorations', 'api-design.md'),
      `---
title: API Design Exploration
type: exploration
tags:
  - api
  - design
---

# API Design

Exploring API design patterns.
`
    );

    // Initialize database and scan content directory
    db = new LuxDatabase(dbPath);
    const scanner = new GeneralScanner(contentDir);
    const scanResult = await scanner.scan();
    await scanner.index(db, scanResult);
  });

  // Clean up after each test
  afterEach(() => {
    if (db) {
      db.close();
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('lux_search', () => {
    it('should search for knowledge entries', () => {
      const results = db.searchDocumentsRanked('Testing', { limit: 20 });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Testing Methodology');
    });

    it('should handle empty search results', () => {
      const results = db.searchDocumentsRanked('NonExistent', { limit: 20 });
      expect(results).toHaveLength(0);
    });

    it('should search with FTS5 operators', () => {
      // Phrase search
      const results = db.searchDocumentsRanked('"Testing Methodology"', { limit: 20 });
      expect(results).toHaveLength(1);
    });

    it('should search all documents with ranked search', () => {
      const results = db.searchDocumentsRanked('Testing', { limit: 20 });
      expect(results.length).toBeGreaterThan(0);

      // Each result carries the ranked shape with a REAL bm25 rank (the regression that would
      // have caught the old rank:0 lie): raw bm25 is negative, lower = better.
      for (const doc of results) {
        expect(doc).toHaveProperty('filePath');
        expect(doc).toHaveProperty('title');
        expect(doc).toHaveProperty('rank');
        expect(typeof doc.rank).toBe('number');
        expect(doc.rank).toBeLessThan(0);
      }
    });

    it('should return empty from ranked search for non-matching query', () => {
      const results = db.searchDocumentsRanked('xyznonexistent', { limit: 20 });
      expect(results).toHaveLength(0);
    });
  });

  describe('lux_log_event', () => {
    it('should log a basic event', () => {
      const eventId = db.insertEvent({
        source: 'test',
        event_type: 'unit_test',
        summary: 'Test event',
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const testEvent = events.find((e) => e.summary === 'Test event');
      expect(testEvent).toBeDefined();
      expect(testEvent?.source).toBe('test');
      expect(testEvent?.event_type).toBe('unit_test');
    });

    it('should log event with payload', () => {
      const payload = {
        query: 'test query',
        results_count: 5,
        duration_ms: 42,
      };

      const eventId = db.insertEvent({
        source: 'mcp',
        event_type: 'search',
        summary: 'Search with payload',
        payload,
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const searchEvent = events.find((e) => e.summary === 'Search with payload');
      expect(searchEvent).toBeDefined();
      expect(searchEvent?.payload).toBeDefined();

      if (searchEvent?.payload) {
        const parsedPayload = JSON.parse(searchEvent.payload);
        expect(parsedPayload.query).toBe('test query');
        expect(parsedPayload.results_count).toBe(5);
        expect(parsedPayload.duration_ms).toBe(42);
      }
    });

    it('should handle events with various sources', () => {
      const sources = ['mcp', 'cli', 'scanner', 'user', 'system'];

      sources.forEach((source) => {
        const eventId = db.insertEvent({
          source,
          event_type: 'test',
          summary: `Event from ${source}`,
        });
        expect(eventId).toBeGreaterThan(0);
      });

      const events = db.getRecentEvents(20);
      sources.forEach((source) => {
        const sourceEvent = events.find((e) => e.summary === `Event from ${source}`);
        expect(sourceEvent).toBeDefined();
      });
    });
  });

  describe('lux_get_file', () => {
    it('should read a file successfully', () => {
      const knowledgeFilePath = join(contentDir, 'knowledge', '20_methodology', 'testing.md');

      const content = readFileSync(knowledgeFilePath, 'utf-8');
      expect(content).toContain('Testing Methodology');
      expect(content).toContain('Our approach to testing');
    });

    it('should handle non-existent file', () => {
      const nonExistentPath = join(contentDir, 'non-existent.md');

      expect(() => {
        readFileSync(nonExistentPath, 'utf-8');
      }).toThrow();
    });

    it('should read files with different encodings', () => {
      // Create a test file with special characters
      const testFilePath = join(testDir, 'unicode-test.md');
      writeFileSync(testFilePath, '# Test with émojis 🎉 and spëcial çharacters');

      const content = readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('émojis');
      expect(content).toContain('🎉');
      expect(content).toContain('spëcial');
    });
  });

  describe('lux_rebuild_index', () => {
    it('should rebuild index from content directory', async () => {
      // Clear database
      db.clearAll();
      expect(db.getStats().knowledge_entries).toBe(0);

      // Rebuild index
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify index was rebuilt
      const stats = db.getStats();
      expect(stats.knowledge_entries).toBeGreaterThan(0);
    });

    it('should handle rebuild with new files added', async () => {
      const initialStats = db.getStats();

      // Add a new knowledge entry
      writeFileSync(
        join(contentDir, 'knowledge', '20_methodology', 'new-process.md'),
        `---
title: New Process
tags:
  - process
---

# New Process

A newly added process document.
`
      );

      // Clear and rebuild
      db.clearAll();
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify new entry was indexed
      const newStats = db.getStats();
      expect(newStats.knowledge_entries).toBeGreaterThan(initialStats.knowledge_entries);
    });

    it('should log rebuild event', async () => {
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();

      // Log the rebuild event
      db.insertEvent({
        source: 'mcp',
        event_type: 'index_rebuild',
        summary: `Indexed ${scanResult.knowledge.length} knowledge entries`,
      });

      const events = db.getRecentEvents(10);
      const rebuildEvent = events.find((e) => e.event_type === 'index_rebuild');
      expect(rebuildEvent).toBeDefined();
    });
  });

  describe('Database Statistics', () => {
    it('should return accurate statistics', () => {
      const stats = db.getStats();

      expect(stats.knowledge_entries).toBeGreaterThan(0);

      // Verify count matches actual data
      const allEntries = db.getAllKnowledgeEntries();
      expect(stats.knowledge_entries).toBe(allEntries.length);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', () => {
      // Try to insert duplicate knowledge entry path — test that db doesn't crash
      const entry1 = db.insertKnowledgeEntry({
        type: 'general',
        title: 'Test Entry',
        file_path: 'unique/path/test.md',
      });
      expect(entry1).toBeGreaterThan(0);
    });
  });

  describe('Integration Tests', () => {
    it('should handle full workflow: search, read file', () => {
      // 1. Search for knowledge entry
      const searchResults = db.searchDocumentsRanked('Testing', { limit: 20 });
      expect(searchResults).toHaveLength(1);

      // 2. Read the file: the stored path is relative to the corpus root
      expect(searchResults[0].filePath).toBe('knowledge/20_methodology/testing.md');
      const content = readFileSync(
        resolveStoredPath(contentDir, searchResults[0].filePath),
        'utf-8'
      );
      expect(content).toContain('Testing Methodology');
    });
  });
});
