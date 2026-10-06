import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import catchMustReport from './eslint-rules/catch-must-report.js';

const ignorePatterns = [
  'dist/**',
  'node_modules/**',
  '*.config.js',
  '*.config.mjs',
  'src/scanner/ast/__tests__/fixtures/javascript/**',
  'src/scanner/adapters/__tests__/fixtures/**',
  'src/scanner/associations/framework/laravel/__tests__/fixtures/**',
];

export default [
  {
    ignores: ignorePatterns,
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'writable',
        require: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        // WHATWG fetch family — Node 22 globals (used by the embeddings weight-cache fetch path).
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        // AbortController/AbortSignal — Node 22 globals bounding the ApiEmbedder fetch (Phase 4, Fix 4).
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...tseslint.configs['recommended-requiring-type-checking'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      // Test doubles that satisfy an async interface (e.g. Embedder.embed → Promise) legitimately
      // have no internal await; require-await is a production-code signal, not meaningful for mocks.
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Issue #6: a run's warnings travel through one channel. Every catch block reports what it caught
  // (or says why it doesn't), and code a rebuild or sync runs prints no warning or error of its own:
  // that goes through the Reporter, the run-warnings printer, or the database notice handler.
  {
    files: ['src/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    plugins: { lux: { rules: { 'catch-must-report': catchMustReport } } },
    rules: {
      'lux/catch-must-report': 'error',
    },
  },
  {
    files: ['src/scanner/**/*.ts', 'src/db/**/*.ts', 'src/cli/index.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name=/^(warn|error)$/]",
          message:
            'Report a warning through the Reporter (or the CLI run-warnings printer), not console.',
        },
      ],
    },
  },
];
