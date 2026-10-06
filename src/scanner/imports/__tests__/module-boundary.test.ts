import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { detectModuleBoundaries, resolveModule } from '../module-boundary.js';
import { tmpdir } from 'node:os';

describe('Module Boundary Detection', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-boundary-test-'));

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('detectModuleBoundaries', () => {
    it('should use config patterns when provided', () => {
      const patterns = detectModuleBoundaries(testDir, {
        patterns: ['custom/path/{name}'],
      });
      expect(patterns).toEqual(['custom/path/{name}']);
    });

    it('should detect src/Module pattern', () => {
      mkdirSync(join(testDir, 'src', 'Module', 'Users'), { recursive: true });
      mkdirSync(join(testDir, 'src', 'Module', 'Orders'), { recursive: true });

      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual(['src/Module/{name}']);
    });

    it('should detect packages pattern', () => {
      mkdirSync(join(testDir, 'packages', 'core'), { recursive: true });
      mkdirSync(join(testDir, 'packages', 'ui'), { recursive: true });

      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual(['packages/{name}']);
    });

    it('should detect apps pattern', () => {
      mkdirSync(join(testDir, 'apps', 'web'), { recursive: true });
      mkdirSync(join(testDir, 'apps', 'api'), { recursive: true });

      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual(['apps/{name}']);
    });

    it('should detect app/Modules pattern', () => {
      mkdirSync(join(testDir, 'app', 'Modules', 'Auth'), { recursive: true });

      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual(['app/Modules/{name}']);
    });

    it('should fall back to top-level dirs with source files', () => {
      mkdirSync(join(testDir, 'auth'), { recursive: true });
      writeFileSync(join(testDir, 'auth', 'login.ts'), 'export const login = () => {}');

      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual(['{name}']);
    });

    it('should return empty when no boundaries detected', () => {
      const patterns = detectModuleBoundaries(testDir);
      expect(patterns).toEqual([]);
    });
  });

  describe('resolveModule', () => {
    it('should resolve file to module via src/Module pattern', () => {
      const result = resolveModule(
        join(testDir, 'src', 'Module', 'Users', 'UserService.php'),
        testDir,
        ['src/Module/{name}']
      );
      expect(result).toBe('Users');
    });

    it('should resolve file to module via packages pattern', () => {
      const result = resolveModule(join(testDir, 'packages', 'core', 'src', 'index.ts'), testDir, [
        'packages/{name}',
      ]);
      expect(result).toBe('core');
    });

    it('should return null for files outside module boundaries', () => {
      const result = resolveModule(join(testDir, 'config', 'app.ts'), testDir, [
        'src/Module/{name}',
      ]);
      expect(result).toBeNull();
    });

    it('should return null for files at root with no matching pattern', () => {
      const result = resolveModule(join(testDir, 'index.ts'), testDir, ['src/Module/{name}']);
      expect(result).toBeNull();
    });

    it('should try multiple patterns and use first match', () => {
      const result = resolveModule(join(testDir, 'packages', 'ui', 'Button.tsx'), testDir, [
        'src/Module/{name}',
        'packages/{name}',
      ]);
      expect(result).toBe('ui');
    });

    it('should resolve repo-relative paths, not just absolute paths', () => {
      const result = resolveModule('src/Module/Seller/RouteServiceProvider.php', testDir, [
        'src/Module/{name}',
      ]);
      expect(result).toBe('Seller');
    });
  });
});
