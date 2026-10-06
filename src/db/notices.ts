// The database layer's two kinds of output, routed to whoever runs it rather than printed here: the
// CLI decides what reaches the terminal (see `setDbNoticeHandler` in cli/index.ts), and a library
// caller that installs nothing sees nothing.
//
//   progress — routine steps (a migration applied). Worth seeing only when asked for (`--verbose`).
//   notice   — something the user should know happened (a stale lock from a crashed run was cleared).

export type DbNoticeKind = 'progress' | 'notice';

type DbNoticeHandler = (kind: DbNoticeKind, message: string) => void;

let handler: DbNoticeHandler = () => {};

export function setDbNoticeHandler(next: DbNoticeHandler): void {
  handler = next;
}

export function dbNotice(kind: DbNoticeKind, message: string): void {
  handler(kind, message);
}
