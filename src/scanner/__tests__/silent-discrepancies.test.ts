// Two defects of one shape: lux swallowing a discrepancy it is in a position to report.
//
// 1. `lux overlay status` prints a surface total and a provider-kind breakdown side
//    by side, as a total and its parts. They are sourced differently — the total from
//    the detector's in-run tally, the breakdown from the rows actually persisted — so
//    when a detected surface does not become a distinct row the two disagree and
//    nothing says so. Observed on a real index: 1039 reported, 1038 rows, breakdown
//    1032 + 6 + 0 = 1038.
//
// 2. buildRegistry() skips an enricher entry whose languageId has no factory, with no
//    error and no warning. A `vue` enricher sat in a working lux.yaml being silently
//    discarded, and the index carried zero Vue symbols — a result indistinguishable
//    from a repository that has no Vue in it.

import { describe, it, expect } from 'vitest';
import { buildRegistry } from '../general.js';
import { warnSink } from '../reporter.js';
import { reconcileSurfaceCounts } from '../rebuild-orchestrator.js';

describe('surface total and provider breakdown must describe one set', () => {
  it('reports the persisted row count, not the detector tally', () => {
    const r = reconcileSurfaceCounts({
      surfacesDetected: 1039,
      controllerBackedCount: 1032,
      closureBackedCount: 6,
      unknownProviderKindCount: 0,
    });

    // 1038 rows were persisted. That is what a reader can go and count.
    expect(r.surfaceCount).toBe(1038);
  });

  it('warns when the detector tally and the persisted rows disagree', () => {
    const r = reconcileSurfaceCounts({
      surfacesDetected: 1039,
      controllerBackedCount: 1032,
      closureBackedCount: 6,
      unknownProviderKindCount: 0,
    });

    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('1039');
    expect(r.warnings[0]).toContain('1038');
  });

  it('is silent when they agree, which is the normal case', () => {
    const r = reconcileSurfaceCounts({
      surfacesDetected: 1038,
      controllerBackedCount: 1032,
      closureBackedCount: 6,
      unknownProviderKindCount: 0,
    });

    expect(r.surfaceCount).toBe(1038);
    expect(r.warnings).toEqual([]);
  });

  it('always yields a total equal to the sum of its parts', () => {
    for (const [c, cl, u] of [
      [0, 0, 0],
      [5, 0, 0],
      [1032, 6, 0],
      [10, 3, 7],
    ]) {
      const r = reconcileSurfaceCounts({
        surfacesDetected: 99999,
        controllerBackedCount: c,
        closureBackedCount: cl,
        unknownProviderKindCount: u,
      });
      expect(r.surfaceCount).toBe(c + cl + u);
    }
  });

  it('reports a detector tally LOWER than the rows too, not just higher', () => {
    // Asymmetry here would hide the opposite anomaly — rows present that no
    // detector claims to have produced.
    const r = reconcileSurfaceCounts({
      surfacesDetected: 3,
      controllerBackedCount: 5,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
    });
    expect(r.surfaceCount).toBe(5);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('buildRegistry must not silently discard a configured enricher', () => {
  it('reports an entry whose languageId has no factory', () => {
    const seen: string[] = [];
    const registry = buildRegistry(
      [{ languageId: 'cobol', enabled: true }],
      warnSink((m) => {
        seen.push(m);
      })
    );

    expect(registry.size).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('cobol');
  });

  it('names the language ids it does support, so the message is actionable', () => {
    const seen: string[] = [];
    buildRegistry(
      [{ languageId: 'kotlin', enabled: true }],
      warnSink((m) => {
        seen.push(m);
      })
    );

    expect(seen[0]).toContain('php');
    expect(seen[0]).toContain('typescript');
    expect(seen[0]).toContain('vue');
  });

  it('says nothing about an entry the operator explicitly disabled', () => {
    const seen: string[] = [];
    const registry = buildRegistry(
      [{ languageId: 'cobol', enabled: false }],
      warnSink((m) => {
        seen.push(m);
      })
    );

    expect(registry.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('says nothing when every entry is recognised', () => {
    const seen: string[] = [];
    const registry = buildRegistry(
      [
        { languageId: 'php', enabled: true },
        { languageId: 'vue', enabled: true },
        { languageId: 'typescript', enabled: true },
      ],
      warnSink((m) => {
        seen.push(m);
      })
    );

    expect(registry.size).toBe(3);
    expect(seen).toEqual([]);
  });

  it('still registers the recognised entries alongside an unrecognised one', () => {
    const seen: string[] = [];
    const registry = buildRegistry(
      [
        { languageId: 'cobol', enabled: true },
        { languageId: 'vue', enabled: true },
      ],
      warnSink((m) => {
        seen.push(m);
      })
    );

    expect(registry.size).toBe(1);
    expect(registry.getByExtension('.vue')?.languageId).toBe('vue');
    expect(seen).toHaveLength(1);
  });

  it('works without a reporter, so existing callers are unaffected', () => {
    expect(() => buildRegistry([{ languageId: 'cobol', enabled: true }])).not.toThrow();
    expect(buildRegistry([{ languageId: 'vue', enabled: true }]).size).toBe(1);
  });
});
