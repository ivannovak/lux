// The MCP server routes database notices to stderr (stdout carries the protocol), and leaves
// routine steps unprinted (issue #6).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dbNotice, setDbNoticeHandler } from '../../db/notices.js';
import { installMcpDbNoticeHandler } from '../db-notices.js';

afterEach(() => {
  vi.restoreAllMocks();
  setDbNoticeHandler(() => {});
});

describe('MCP database notices', () => {
  it('writes a notice to stderr and nothing for a routine step', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    installMcpDbNoticeHandler();

    dbNotice('notice', 'cleared a stale database lock left by a previously interrupted run.');
    dbNotice('progress', 'Applying migration 1: initial_schema');

    expect(stderr.mock.calls).toEqual([
      ['Note: cleared a stale database lock left by a previously interrupted run.'],
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('is installed by the server before anything opens a database', () => {
    const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8');
    const install = source.indexOf('installMcpDbNoticeHandler();');
    expect(install).toBeGreaterThan(0);
    expect(source.indexOf('new WorkspaceRuntime(')).toBeGreaterThan(install);
  });
});
