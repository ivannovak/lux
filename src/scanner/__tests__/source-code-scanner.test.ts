import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { GeneralScanner } from '../index.js';

describe('GeneralScanner - Source Code Scanning', () => {
  /**
   * Helper to create a temporary directory with files and clean up after.
   */
  function withTempDir(
    name: string,
    setup: (root: string) => void,
    test: (root: string) => Promise<void>
  ): () => Promise<void> {
    return async () => {
      const tempPath = join(__dirname, `temp-${name}`);
      try {
        mkdirSync(tempPath, { recursive: true });
        setup(tempPath);
        await test(tempPath);
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    };
  }

  describe('source code detection', () => {
    it(
      'should scan .ts files when package.json is present',
      withTempDir(
        'ts-files',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          // package.json itself is also scanned as a json config file
          const tsEntries = sourceEntries.filter((k) => k.title === 'src/app.ts');
          expect(tsEntries).toHaveLength(1);
          expect(tsEntries[0].content).toBe('export const x = 1;');
          expect(tsEntries[0].frontmatter).toEqual({
            language: 'typescript',
            extension: '.ts',
          });
        }
      )
    );

    it(
      'should NOT scan source code when no manifest file exists',
      withTempDir(
        'no-manifest',
        (root) => {
          mkdirSync(join(root, 'src'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          expect(sourceEntries).toHaveLength(0);
        }
      )
    );

    it(
      'should detect repository via composer.json',
      withTempDir(
        'composer',
        (root) => {
          writeFileSync(join(root, 'composer.json'), '{}');
          writeFileSync(join(root, 'index.php'), '<?php echo "hello";');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const phpEntries = result.knowledge.filter(
            (k) => k.type === 'source-code' && k.frontmatter?.language === 'php'
          );
          expect(phpEntries).toHaveLength(1);
          expect(phpEntries[0].frontmatter).toEqual({
            language: 'php',
            extension: '.php',
          });
        }
      )
    );

    it(
      'should detect repository via go.mod',
      withTempDir(
        'gomod',
        (root) => {
          writeFileSync(join(root, 'go.mod'), 'module example.com/test');
          writeFileSync(join(root, 'main.go'), 'package main');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          expect(sourceEntries).toHaveLength(1);
          expect(sourceEntries[0].frontmatter).toEqual({
            language: 'go',
            extension: '.go',
          });
        }
      )
    );
  });

  describe('exclusion patterns', () => {
    it(
      'should exclude node_modules/',
      withTempDir(
        'exclude-nm',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src'), { recursive: true });
          mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
          writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = {};');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          const titles = sourceEntries.map((e) => e.title);
          expect(titles).toContain('src/app.ts');
          expect(titles.some((t) => t.includes('node_modules'))).toBe(false);
        }
      )
    );

    it(
      'should exclude vendor/',
      withTempDir(
        'exclude-vendor',
        (root) => {
          writeFileSync(join(root, 'composer.json'), '{}');
          mkdirSync(join(root, 'src'), { recursive: true });
          mkdirSync(join(root, 'vendor', 'pkg'), { recursive: true });
          writeFileSync(join(root, 'src', 'Controller.php'), '<?php class Controller {}');
          writeFileSync(join(root, 'vendor', 'pkg', 'lib.php'), '<?php class Lib {}');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          const titles = sourceEntries.map((e) => e.title);
          expect(titles).toContain('src/Controller.php');
          expect(titles.some((t) => t.includes('vendor'))).toBe(false);
        }
      )
    );

    it(
      'should exclude dist/ and build/',
      withTempDir(
        'exclude-dist',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src'), { recursive: true });
          mkdirSync(join(root, 'dist'), { recursive: true });
          mkdirSync(join(root, 'build'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
          writeFileSync(join(root, 'dist', 'app.js'), 'const x = 1;');
          writeFileSync(join(root, 'build', 'app.js'), 'const x = 1;');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          const titles = sourceEntries.map((e) => e.title);
          expect(titles).toContain('src/app.ts');
          expect(titles.some((t) => t.includes('dist/'))).toBe(false);
          expect(titles.some((t) => t.includes('build/'))).toBe(false);
        }
      )
    );

    it(
      'should exclude .min.js files',
      withTempDir(
        'exclude-min',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.js'), 'const x = 1;');
          writeFileSync(join(root, 'src', 'app.min.js'), 'const x=1;');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');
          const titles = sourceEntries.map((e) => e.title);
          expect(titles).toContain('src/app.js');
          expect(titles.some((t) => t.includes('.min.js'))).toBe(false);
        }
      )
    );
  });

  describe('language detection', () => {
    it(
      'should detect languages from various extensions',
      withTempDir(
        'lang-detect',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          writeFileSync(join(root, 'app.ts'), 'const x = 1;');
          writeFileSync(join(root, 'app.tsx'), 'const x = 1;');
          writeFileSync(join(root, 'app.js'), 'const x = 1;');
          writeFileSync(join(root, 'app.py'), 'x = 1');
          writeFileSync(join(root, 'app.rb'), 'x = 1');
          writeFileSync(join(root, 'app.rs'), 'fn main() {}');
          writeFileSync(join(root, 'app.go'), 'package main');
          writeFileSync(join(root, 'app.java'), 'class App {}');
          writeFileSync(join(root, 'app.vue'), '<template></template>');
          writeFileSync(join(root, 'app.c'), 'int main() {}');
          writeFileSync(join(root, 'app.cpp'), 'int main() {}');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');

          const langMap = new Map(
            sourceEntries.map((e) => [
              e.frontmatter?.extension as string,
              e.frontmatter?.language as string,
            ])
          );

          expect(langMap.get('.ts')).toBe('typescript');
          expect(langMap.get('.tsx')).toBe('typescript');
          expect(langMap.get('.js')).toBe('javascript');
          expect(langMap.get('.py')).toBe('python');
          expect(langMap.get('.rb')).toBe('ruby');
          expect(langMap.get('.rs')).toBe('rust');
          expect(langMap.get('.go')).toBe('go');
          expect(langMap.get('.java')).toBe('java');
          expect(langMap.get('.vue')).toBe('vue');
          expect(langMap.get('.c')).toBe('c');
          expect(langMap.get('.cpp')).toBe('cpp');
        }
      )
    );
  });

  describe('coexistence with markdown scanning', () => {
    it(
      'should scan both markdown and source code files',
      withTempDir(
        'mixed',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          writeFileSync(join(root, 'README.md'), '---\ntitle: Readme\n---\n# Hello');
          mkdirSync(join(root, 'src'), { recursive: true });
          writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const mdEntries = result.knowledge.filter((k) => k.type !== 'source-code');
          const sourceEntries = result.knowledge.filter((k) => k.type === 'source-code');

          expect(mdEntries.length).toBeGreaterThanOrEqual(1);
          expect(sourceEntries.length).toBeGreaterThanOrEqual(1);

          // Markdown entry should have parsed frontmatter
          const readme = mdEntries.find((k) => k.title === 'Readme');
          expect(readme).toBeDefined();

          // Source code entry should have raw content
          const tsEntry = sourceEntries.find((k) => k.title === 'src/app.ts');
          expect(tsEntry).toBeDefined();
          expect(tsEntry?.content).toBe('export const x = 1;');
        }
      )
    );

    it(
      'should still scan markdown correctly without source code',
      withTempDir(
        'md-only',
        (root) => {
          writeFileSync(
            join(root, 'doc.md'),
            '---\ntitle: A Document\ntags:\n  - test\n---\n# Content'
          );
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          expect(result.knowledge).toHaveLength(1);
          expect(result.knowledge[0].type).toBe('general');
          expect(result.knowledge[0].title).toBe('A Document');
          expect(result.knowledge[0].tags).toEqual(['test']);
        }
      )
    );
  });

  describe('title and tags', () => {
    it(
      'should use relative file path as title for source code entries',
      withTempDir(
        'title-path',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src', 'services'), { recursive: true });
          writeFileSync(join(root, 'src', 'services', 'auth.ts'), 'export class Auth {}');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const authEntry = result.knowledge.find(
            (k) => k.type === 'source-code' && k.title === 'src/services/auth.ts'
          );
          expect(authEntry).toBeDefined();
        }
      )
    );

    it(
      'should infer tags from path segments',
      withTempDir(
        'tags-path',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          mkdirSync(join(root, 'src', 'services'), { recursive: true });
          writeFileSync(join(root, 'src', 'services', 'auth.ts'), 'export class Auth {}');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const authEntry = result.knowledge.find(
            (k) => k.type === 'source-code' && k.title === 'src/services/auth.ts'
          );
          expect(authEntry).toBeDefined();
          // 'src' is filtered out as uninformative; 'services' and 'auth' remain
          expect(authEntry?.tags).toContain('services');
          expect(authEntry?.tags).toContain('auth');
          expect(authEntry?.tags).not.toContain('src');
        }
      )
    );
  });

  describe('content', () => {
    it(
      'should contain actual file content for source code entries',
      withTempDir(
        'content-check',
        (root) => {
          writeFileSync(join(root, 'package.json'), '{}');
          const code = `import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default router;`;
          writeFileSync(join(root, 'router.ts'), code);
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const router = result.knowledge.find((k) => k.title === 'router.ts');
          expect(router?.content).toBe(
            `import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default router;`
          );
        }
      )
    );
  });

  describe('LSP enrichment compatibility', () => {
    it(
      'should produce entries with filePath that has correct extensions for LSP matching',
      withTempDir(
        'lsp-compat',
        (root) => {
          writeFileSync(join(root, 'composer.json'), '{}');
          mkdirSync(join(root, 'app'), { recursive: true });
          writeFileSync(join(root, 'app', 'Controller.php'), '<?php class Controller {}');
        },
        async (root) => {
          const scanner = new GeneralScanner(root);
          const result = await scanner.scan();

          const phpEntry = result.knowledge.find((k) => k.filePath.endsWith('.php'));
          expect(phpEntry).toBeDefined();
          expect(phpEntry?.type).toBe('source-code');
          // filePath should be absolute for LSP enrichment
          expect(phpEntry?.filePath.startsWith('/')).toBe(true);
        }
      )
    );
  });
});
