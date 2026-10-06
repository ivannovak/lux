/* global process, Buffer */
// A minimal language server for CLI tests that need an LSP enricher to come up: it answers
// `initialize`, returns no symbols and no definitions, and exits on `exit`. Tests point an
// enricher's `server_command` at `node <this file>`, so they do not depend on a language server
// being installed on the machine.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === 'exit') process.exit(0);
  if (message.id === undefined) return; // a notification
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
  } else if (message.method === 'textDocument/documentSymbol') {
    send({ id: message.id, result: [] });
  } else {
    send({ id: message.id, result: null });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
