// The MCP server's handler for database notices. stdout carries the MCP protocol, so a notice (a
// stale lock cleared) goes to stderr; routine steps such as migrations are not printed.

import { setDbNoticeHandler } from '../db/notices.js';

export function installMcpDbNoticeHandler(): void {
  setDbNoticeHandler((kind, message) => {
    if (kind === 'notice') console.error(`Note: ${message}`);
  });
}
