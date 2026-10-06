// Id-portability classifier + three-class keying (spec 12 / Decisions 2,3 / SC-4). The unit-level
// false-merge + positive-merge fixtures; the walk-level, cross-DB proof lives in
// federation-trace.test.ts (two real .lux fixtures).

import { describe, expect, it } from 'vitest';
import {
  federationKey,
  idBridges,
  idPortability,
  isKernelSet,
  type FederationRepo,
} from '../federation.js';

const MAIN: FederationRepo = { name: 'main', role: 'primary' };
const KERNEL: FederationRepo = { name: 'sib_core', role: 'kernel' };
const PEER: FederationRepo = { name: 'sib_res', role: 'peer' };

describe('idPortability', () => {
  it('is portable ONLY for a namespace-qualified PHP FQCN', () => {
    expect(idPortability('symbol:php:Acme\\Core\\OfferController::show')).toBe('portable');
    expect(idPortability('symbol:php:App\\Http\\Kernel')).toBe('portable');
  });

  it('is repo-local for a bare-name PHP id (the global-namespace false-merge guard)', () => {
    // No `\` ⇒ the id builders fell back to the short name (symbols.ts:46 / materializer.ts:124).
    expect(idPortability('symbol:php:helper')).toBe('repo-local');
    expect(idPortability('symbol:php:handle')).toBe('repo-local');
  });

  it('is repo-local for an HTTP surface two files declare: the id names one declaration', () => {
    expect(idPortability('surface:http:GET:/#file:routes/web.php')).toBe('repo-local');
  });

  it('is portable-kernel-only for an HTTP surface', () => {
    expect(idPortability('surface:http:GET:/offer/{offerId}')).toBe('portable-kernel-only');
  });

  it('is repo-local for path-relative + non-http + contract + operational ids', () => {
    expect(idPortability('file:routes/web.php')).toBe('repo-local');
    expect(idPortability('symbol:ts:src/index.ts#main')).toBe('repo-local');
    expect(idPortability('surface:cli:invoices:sync')).toBe('repo-local');
    expect(idPortability('contract:route:offers.show')).toBe('repo-local');
  });
});

describe('federationKey — the three-class law (Decision 3)', () => {
  it('portable id keys bare in every repo (one logical node)', () => {
    const id = 'symbol:php:Acme\\Core\\X';
    expect(federationKey(MAIN, id)).toBe(id);
    expect(federationKey(KERNEL, id)).toBe(id);
    expect(federationKey(PEER, id)).toBe(id); // portable merges across ALL repos
  });

  it('bare-name PHP id keys (repo,id) in every repo — NEVER merges (false-merge guard)', () => {
    const id = 'symbol:php:helper';
    const kMain = federationKey(MAIN, id);
    const kKernel = federationKey(KERNEL, id);
    const kPeer = federationKey(PEER, id);
    expect(new Set([kMain, kKernel, kPeer]).size).toBe(3); // three distinct keys
    expect(kMain).toBe('main\0symbol:php:helper');
  });

  it('http surface keys bare within {primary ∪ kernel}, (repo,id) toward a peer', () => {
    const id = 'surface:http:GET:/offer/{offerId}';
    expect(federationKey(MAIN, id)).toBe(id);
    expect(federationKey(KERNEL, id)).toBe(id); // same key as primary ⇒ merges toward the kernel
    expect(federationKey(PEER, id)).toBe('sib_res\0' + id); // distinct per peer
  });

  it('file: and symbol:ts: ids key (repo,id) — never merge', () => {
    for (const id of ['file:routes/web.php', 'symbol:ts:src/index.ts#main']) {
      expect(
        new Set([federationKey(MAIN, id), federationKey(KERNEL, id), federationKey(PEER, id)]).size
      ).toBe(3);
    }
  });
});

describe('idBridges — which repos a node may expand into', () => {
  it('portable bridges anywhere; bare-name PHP + path-relative bridge nowhere', () => {
    expect(idBridges('symbol:php:Acme\\Core\\X', MAIN, PEER)).toBe(true);
    expect(idBridges('symbol:php:helper', MAIN, KERNEL)).toBe(false);
    expect(idBridges('file:routes/web.php', MAIN, KERNEL)).toBe(false);
    expect(idBridges('symbol:ts:src/index.ts#main', MAIN, PEER)).toBe(false);
  });

  it('http surface bridges only within {primary ∪ kernel}', () => {
    const id = 'surface:http:GET:/x';
    expect(idBridges(id, MAIN, KERNEL)).toBe(true);
    expect(idBridges(id, KERNEL, MAIN)).toBe(true);
    expect(idBridges(id, MAIN, PEER)).toBe(false); // never toward a peer
    expect(idBridges(id, PEER, MAIN)).toBe(false);
  });

  it('same repo always bridges (trivially)', () => {
    expect(idBridges('file:routes/web.php', PEER, PEER)).toBe(true);
    expect(isKernelSet(KERNEL)).toBe(true);
    expect(isKernelSet(PEER)).toBe(false);
  });
});
