import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { GeneralScanner } from '../index.js';
import { LuxDatabase } from '../../db/index.js';
import type { ScanResult } from '../types.js';

describe('GeneralScanner', () => {
  const fixturesPath = join(__dirname, 'fixtures');

  describe('constructor', () => {
    it('should create scanner with root path', () => {
      const scanner = new GeneralScanner('/test/path');
      expect(scanner).toBeInstanceOf(GeneralScanner);
    });

    it('should create scanner without root path', () => {
      const scanner = new GeneralScanner();
      expect(scanner).toBeInstanceOf(GeneralScanner);
    });
  });

  describe('scan()', () => {
    it('should throw error if no root path provided', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.scan()).rejects.toThrow(
        'Root path must be provided either to constructor or scan()'
      );
    });

    it('should use constructor root path if not provided to scan()', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();
      expect(result).toBeDefined();
      expect(result.knowledge).toBeInstanceOf(Array);
    });

    it('should use scan() root path over constructor path', async () => {
      const scanner = new GeneralScanner('/wrong/path');
      const result = await scanner.scan(fixturesPath);
      expect(result).toBeDefined();
      expect(result.knowledge).toBeInstanceOf(Array);
    });

    it('should scan knowledge entries correctly', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      expect(result.knowledge.length).toBeGreaterThan(0);

      const methodologyEntry = result.knowledge.find((k) => k.type === 'methodology');
      expect(methodologyEntry).toBeDefined();
      expect(methodologyEntry?.title).toBe('Agile Development Process');
      expect(methodologyEntry?.tags).toEqual(['agile', 'process']);
      expect(methodologyEntry?.content).toContain('Our standard agile methodology');
    });

    it('should scan markdown files recursively', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      // Should find markdown files from various subdirectories
      expect(result.knowledge.length).toBeGreaterThan(0);

      // All entries should have required fields
      for (const entry of result.knowledge) {
        expect(entry.filePath).toBeTruthy();
        expect(entry.type).toBeTruthy();
        expect(entry.title).toBeTruthy();
      }
    });

    it('should infer knowledge type from file path', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const methodologyEntry = result.knowledge.find((k) => k.filePath.includes('methodology'));
      expect(methodologyEntry?.type).toBe('methodology');
    });

    it('should scan explorations as knowledge entries', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const exploration = result.knowledge.find(
        (k) => k.type === 'exploration' && k.filePath.includes('explorations')
      );
      expect(exploration).toBeDefined();
      expect(exploration?.title).toBe('API Design Exploration');
      expect(exploration?.tags).toEqual(['api', 'design']);
    });

    it('should handle empty root directory', async () => {
      const tempPath = join(__dirname, 'temp-empty');

      try {
        mkdirSync(tempPath, { recursive: true });

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.knowledge).toHaveLength(0);
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should respect frontmatter type over directory inference', async () => {
      const tempPath = join(__dirname, 'temp-type');
      const knowledgePath = join(tempPath, 'knowledge/20_methodology');

      try {
        mkdirSync(knowledgePath, { recursive: true });
        writeFileSync(
          join(knowledgePath, 'custom.md'),
          '---\ntitle: Custom\ntype: custom-type\n---\n# Custom'
        );

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.knowledge[0].type).toBe('custom-type');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should extract title from frontmatter name field', async () => {
      const tempPath = join(__dirname, 'temp-name');

      try {
        mkdirSync(tempPath, { recursive: true });
        writeFileSync(join(tempPath, 'test.md'), '---\nname: My Named File\n---\n# Content');

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.knowledge[0].title).toBe('My Named File');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should extract title from filename when no frontmatter', async () => {
      const tempPath = join(__dirname, 'temp-filename');

      try {
        mkdirSync(tempPath, { recursive: true });
        writeFileSync(join(tempPath, 'my-great-doc.md'), '# Just content, no frontmatter');

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.knowledge[0].title).toBe('My Great Doc');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should remove date prefix from filename titles', async () => {
      const tempPath = join(__dirname, 'temp-date-title');

      try {
        mkdirSync(tempPath, { recursive: true });
        writeFileSync(join(tempPath, '2024-01-15_project-kickoff.md'), '# Meeting');

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.knowledge[0].title).toBe('Project Kickoff');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('index()', () => {
    let mockDb: LuxDatabase;
    let scanResult: ScanResult;

    beforeEach(() => {
      // Create mock database
      mockDb = {
        transaction: <T>(fn: () => T): T => fn(),
        inTransaction: () => true,
        insertKnowledgeEntry: vi.fn(() => 1),
      } as unknown as LuxDatabase;

      // Create valid scan result
      scanResult = {
        knowledge: [
          {
            type: 'methodology',
            title: 'Test Knowledge',
            filePath: '/test/knowledge.md',
            content: 'Knowledge content',
          },
        ],
      };
    });

    it('should throw error if database not provided', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.index(null as any, scanResult)).rejects.toThrow(
        'Database instance is required for indexing'
      );
    });

    it('should throw error if scan result is invalid', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.index(mockDb, null as any)).rejects.toThrow(
        'Invalid scan result: must be an object'
      );
    });

    it('should throw error if knowledge array is missing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = { knowledge: undefined as any };
      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid scan result: knowledge must be an array'
      );
    });

    it('should index all entities successfully', async () => {
      const scanner = new GeneralScanner();
      const result = await scanner.index(mockDb, scanResult);

      expect(result).toEqual({
        knowledge: 1,
      });

      expect(mockDb.insertKnowledgeEntry).toHaveBeenCalledTimes(1);
    });

    it('should validate knowledge data before indexing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        knowledge: [
          {
            type: '',
            title: 'Test',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid knowledge entry: missing or invalid type'
      );
    });

    it('should validate knowledge title', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        knowledge: [
          {
            type: 'methodology',
            title: '',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid knowledge entry: missing or invalid title'
      );
    });

    it('should handle database insertion errors gracefully', async () => {
      const scanner = new GeneralScanner();
      const errorDb = {
        transaction: <T>(fn: () => T): T => fn(),
        inTransaction: () => true,
        insertKnowledgeEntry: vi.fn(() => {
          throw new Error('DB constraint violation');
        }),
      } as unknown as LuxDatabase;

      await expect(scanner.index(errorDb, scanResult)).rejects.toThrow(
        'Failed to insert knowledge entry "Test Knowledge"'
      );
    });

    it('should provide partial index information on error', async () => {
      const scanner = new GeneralScanner();
      const multiResult: ScanResult = {
        knowledge: [
          {
            type: 'methodology',
            title: 'First Entry',
            filePath: '/test/first.md',
            content: 'First',
          },
          {
            type: 'methodology',
            title: 'Second Entry',
            filePath: '/test/second.md',
            content: 'Second',
          },
        ],
      };

      let callCount = 0;
      const partialDb = {
        transaction: <T>(fn: () => T): T => fn(),
        inTransaction: () => true,
        insertKnowledgeEntry: vi.fn(() => {
          callCount++;
          if (callCount === 2) throw new Error('Second insertion failed');
          return 1;
        }),
      } as unknown as LuxDatabase;

      try {
        await scanner.index(partialDb, multiResult);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Partial index created: 1 knowledge entries');
      }
    });

    it('commits the entries before a failing one in a single transaction', async () => {
      const scanner = new GeneralScanner();
      const db = new LuxDatabase(':memory:');
      const transaction = vi.spyOn(db, 'transaction');
      const result: ScanResult = {
        knowledge: [
          { type: 'methodology', title: 'First', filePath: '/test/first.md', content: 'First' },
          { type: 'methodology', title: 'Second', filePath: '/test/second.md', content: 'Second' },
          { type: 'methodology', title: '', filePath: '/test/untitled.md', content: 'Untitled' },
        ],
      };

      await expect(scanner.index(db, result)).rejects.toThrow(
        'Partial index created: 2 knowledge entries'
      );
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(db.getAllKnowledgeEntries().map((e) => e.title)).toEqual(['First', 'Second']);
      db.close();
    });

    it.each([
      [
        'ABORT',
        'only the failing statement',
        'Partial index created: 2 knowledge entries',
        ['First', 'Second'],
      ],
      ['ROLLBACK', 'the whole transaction', 'Partial index created: 0 knowledge entries', []],
    ])(
      'reports what committed when a RAISE(%s) undoes %s',
      async (mode, _undone, partial, committed) => {
        const scanner = new GeneralScanner();
        const db = new LuxDatabase(':memory:');
        const sqlite = (db as unknown as { db: { exec(sql: string): void } }).db;
        sqlite.exec(
          `CREATE TRIGGER fail_third BEFORE INSERT ON knowledge_entries
             WHEN (SELECT count(*) FROM knowledge_entries) >= 2
           BEGIN SELECT RAISE(${mode}, 'injected failure'); END;`
        );
        const result: ScanResult = {
          knowledge: ['First', 'Second', 'Third', 'Fourth'].map((title) => ({
            type: 'methodology',
            title,
            filePath: `/test/${title}.md`,
            content: title,
          })),
        };

        const error = await scanner.index(db, result).catch((e: Error) => e);

        expect((error as Error).message).toContain(partial);
        expect((error as Error).message).toContain('injected failure');
        expect((error as Error).message).not.toContain('no transaction is active');
        expect(db.getAllKnowledgeEntries().map((e) => e.title)).toEqual(committed);
        db.close();
      }
    );

    it('should handle empty scan result', async () => {
      const scanner = new GeneralScanner();
      const emptyResult: ScanResult = {
        knowledge: [],
      };

      const result = await scanner.index(mockDb, emptyResult);

      expect(result).toEqual({
        knowledge: 0,
      });
    });

    it('should pass metadata and content to database', async () => {
      const scanner = new GeneralScanner();
      const resultWithMetadata: ScanResult = {
        knowledge: [
          {
            type: 'methodology',
            title: 'Test Knowledge',
            filePath: '/test/knowledge.md',
            tags: ['tag1', 'tag2'],
            frontmatter: { title: 'Test Knowledge', custom: 'value' },
            content: 'Test content',
          },
        ],
      };

      await scanner.index(mockDb, resultWithMetadata);

      expect(mockDb.insertKnowledgeEntry).toHaveBeenCalledWith({
        type: 'methodology',
        title: 'Test Knowledge',
        file_path: '/test/knowledge.md',
        tags: ['tag1', 'tag2'],
        metadata: { title: 'Test Knowledge', custom: 'value' },
        content: 'Test content',
      });
    });

    it('should handle non-Error exceptions during indexing', async () => {
      const scanner = new GeneralScanner();

      const errorDb = {
        transaction: <T>(fn: () => T): T => fn(),
        inTransaction: () => true,
        insertKnowledgeEntry: vi.fn(() => {
          throw 'String error'; // Non-Error exception
        }),
      } as unknown as LuxDatabase;

      await expect(scanner.index(errorDb, scanResult)).rejects.toThrow();
    });
  });
});
