// Tests for tranche-one ownership attribution.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import type { FeaturePathDirectEvidenceItem, FeaturePathTarget } from '../contract.js';
import { attributeFeaturePathOwnership } from '../ownership.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-ownership-test-'));

function makeRepoRoot(...subpaths: string[]): string {
  for (const sub of subpaths) {
    mkdirSync(join(testDir, sub), { recursive: true });
  }
  return testDir;
}

function routeTarget(filePath?: string): FeaturePathTarget {
  return {
    kind: 'route-surface',
    id: 'surface:http:POST:/offers',
    label: 'POST /offers',
    surfaceMethod: 'POST',
    surfacePath: '/offers',
    filePath: filePath ?? null,
  };
}

function routeDeclaration(filePath: string): FeaturePathDirectEvidenceItem {
  return {
    kind: 'route-declaration',
    description: 'declared',
    filePath,
    trustTier: 5,
    confidenceClass: 'proven',
  };
}

function handlerRecovery(filePath: string): FeaturePathDirectEvidenceItem {
  return {
    kind: 'handler-recovery',
    description: 'recovered',
    filePath,
    trustTier: 3,
    confidenceClass: 'framework-inferred',
  };
}

describe('attributeFeaturePathOwnership', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when no file path is available anywhere', () => {
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [],
      repoRoot: testDir,
    });
    expect(result).toBeNull();
  });

  it('prefers handler-recovery file path over route-declaration when both are present', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings', 'app/Modules/Routing');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [
        routeDeclaration('app/Modules/Routing/routes.php'),
        handlerRecovery('app/Modules/Listings/OfferController.php'),
      ],
      repoRoot,
    });
    expect(result?.regionName).toBe('Listings');
    expect(result?.basis).toBe('module-boundary');
  });

  it('falls back to route-declaration file path when no handler is recovered', () => {
    const repoRoot = makeRepoRoot('app/Modules/Routing');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [routeDeclaration('app/Modules/Routing/routes.php')],
      repoRoot,
    });
    expect(result?.regionName).toBe('Routing');
  });

  it('uses target.filePath when no direct evidence is provided', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings');
    const target: FeaturePathTarget = {
      ...routeTarget(),
      filePath: 'app/Modules/Listings/OfferSurface.php',
    };
    const result = attributeFeaturePathOwnership({
      target,
      directEvidence: [],
      repoRoot,
    });
    expect(result?.regionName).toBe('Listings');
  });

  it('emits trustTier 5 when a configured pattern is the matching basis', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [handlerRecovery('app/Modules/Listings/OfferController.php')],
      repoRoot,
      moduleBoundaryConfig: { patterns: ['app/Modules/{name}'] },
    });
    expect(result?.basis).toBe('module-boundary');
    expect(result?.trustTier).toBe(5);
    expect(result?.rationale).toContain('configured');
  });

  it('emits trustTier 4 when an auto-detected known pattern is the basis', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [handlerRecovery('app/Modules/Listings/OfferController.php')],
      repoRoot,
    });
    expect(result?.basis).toBe('module-boundary');
    expect(result?.trustTier).toBe(4);
  });

  it('returns directory-led ownership for {name} fallback patterns', () => {
    // When detectModuleBoundaries finds no known pattern but does find top-level
    // source dirs, it returns ['{name}']. Construct that case.
    const repoRoot = makeRepoRoot('domain/Listings');
    // Add a source file so getTopLevelSourceDirs picks it up.
    writeFileSync(join(repoRoot, 'domain', 'Listings', 'OfferController.php'), '<?php');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [handlerRecovery('domain/Listings/OfferController.php')],
      repoRoot,
    });
    expect(result?.basis).toBe('directory-led');
    expect(result?.trustTier).toBe(3);
    expect(result?.regionName).toBe('domain');
  });

  it('returns unresolved when no boundary pattern matches the file path', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [handlerRecovery('vendor/some-lib/SomeFile.php')],
      repoRoot,
    });
    expect(result?.basis).toBe('unresolved');
    expect(result?.trustTier).toBe(1);
    expect(result?.rationale).toContain('vendor/some-lib/SomeFile.php');
  });

  it('returns unresolved when no patterns are detectable for the repo root', () => {
    // testDir exists but has no subdirectories at all.
    const result = attributeFeaturePathOwnership({
      target: routeTarget('some/file.php'),
      directEvidence: [],
      repoRoot: testDir,
    });
    expect(result?.basis).toBe('unresolved');
    expect(result?.regionName).toBe('unresolved');
  });

  it('produces a stable regionId of the form module:{name}', () => {
    const repoRoot = makeRepoRoot('app/Modules/Listings');
    const result = attributeFeaturePathOwnership({
      target: routeTarget(),
      directEvidence: [handlerRecovery('app/Modules/Listings/OfferController.php')],
      repoRoot,
    });
    expect(result?.regionId).toBe('module:Listings');
  });
});
