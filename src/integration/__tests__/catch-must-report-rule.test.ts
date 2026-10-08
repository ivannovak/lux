// Self-check for the structural warning guards (issue #6): the `lux/catch-must-report` ESLint rule
// and the console restriction. Each evasion that defeated the earlier text-matching guard is run
// through the rule and must be rejected; each legitimate way of reporting must pass.

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { ESLint } from 'eslint';

// The repository's own ESLint configuration, limited to the two guard rules and parsed without the
// type-checking project, so in-memory samples can be linted at any path under src/.
const eslint = new ESLint({
  cwd: join(__dirname, '..', '..', '..'),
  overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { project: null } } }],
  ruleFilter: ({ ruleId }) =>
    ruleId === 'lux/catch-must-report' || ruleId === 'no-restricted-syntax',
});

async function ruleIds(code: string, filePath: string): Promise<Array<string | null>> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId);
}

const REPORTING = [
  'try { f(); } catch (e) { throw e; }',
  'try { f(); } catch (e) { warn(`f failed — ${String(e)}`); }',
  'try { f(); } catch (e) { reporter.warn(String(e), "detector:x"); }',
  'try { f(); } catch (e) { onWarn?.(String(e)); }',
  'try { f(); } catch (e) { runWarnings.push(String(e)); }',
  'try { f(); } catch (e) { enrichFailures.push({ item: "a", error: String(e) }); }',
  'try { f(); } catch (e) { printError(String(e)); process.exit(1); }',
  'try { f(); } catch {\n  // lux-intentional-swallow: a probe; the negative result is the answer.\n  g();\n}',
];

const SWALLOWING = [
  // The ten evasions of the text-matching guard, each inside a catch with nothing that reports.
  'try { f(); } catch (e) { const m = `Warning: ${String(e)}`; report(m); }',
  'try { f(); } catch (e) { report(["f", "failed"].join(" ")); }',
  'try { f(); } catch (e) { console.warn(`Warning: ${String(e)}`); }',
  'try { f(); } catch (e) { const log = report; log("f failed"); }',
  'try { f(); } catch (e) { progress("f failed"); }',
  'try { f(); } catch { report("f: 0 results"); }',
  'try { f(); } catch { report("f timed out; unable to continue"); }',
  'try { f(); } catch { onProgress!("f failed"); }',
  'try { f(); } catch (err) { report(String(err)); }',
  'try { f(); } catch { /* ignore */ }',
  // A marker with no reason is not a justification.
  'try { f(); } catch {\n  // lux-intentional-swallow:\n}',
  // A push onto a list that is never reported does not count.
  'try { f(); } catch (e) { seen.push(String(e)); }',
];

const wrap = (body: string): string => `export function x(): void {\n${body}\n}\n`;

describe('lux/catch-must-report', () => {
  it('accepts each way of reporting what was caught', async () => {
    for (const sample of REPORTING) {
      expect(await ruleIds(wrap(sample), 'src/scanner/sample.ts'), sample).not.toContain(
        'lux/catch-must-report'
      );
    }
  });

  it('rejects each evasion', async () => {
    for (const sample of SWALLOWING) {
      expect(await ruleIds(wrap(sample), 'src/scanner/sample.ts'), sample).toContain(
        'lux/catch-must-report'
      );
    }
  });
});

describe('console restriction in run code', () => {
  it('rejects console.warn and console.error in scanner, db and CLI run code', async () => {
    for (const path of ['src/scanner/sample.ts', 'src/db/sample.ts', 'src/cli/index.ts']) {
      for (const call of ['console.warn("Warning: x");', 'console.error("x");']) {
        expect(await ruleIds(wrap(call), path), `${call} in ${path}`).toContain(
          'no-restricted-syntax'
        );
      }
    }
  });
});
