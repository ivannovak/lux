// lux/catch-must-report: a `catch` block must report what it caught (issue #6).
//
// A failure a run absorbs and says nothing about is how a degraded run reads as complete. So every
// catch block must do one of:
//   - rethrow (any `throw` inside it), or end the process (`process.exit(…)`) after saying why;
//   - call a warning sink: `warn(…)`, `x.warn(…)`, `onWarn(…)`, `onWarning(…)`, `reporter.warn(…)`;
//   - push onto a list that is reported later: `…Warnings`, `…Failures`, `…Errors`, `…Diagnostics`;
//   - or carry `// lux-intentional-swallow: <reason>` inside it, saying why nothing is reported.
// `console.warn` and progress loggers do not count: a warning printed or logged as progress never
// reaches the run's warnings.

const WARN_CALLEES = new Set(['warn', 'onWarn', 'onWarning']);
const MARKER = /lux-intentional-swallow:\s*\S/;

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  if (callee.type === 'ChainExpression') return calleeName(callee.expression);
  return null;
}

function objectName(callee) {
  if (callee.type === 'ChainExpression') return objectName(callee.expression);
  if (callee.type !== 'MemberExpression') return null;
  const obj = callee.object;
  if (obj.type === 'Identifier') return obj.name;
  if (obj.type === 'MemberExpression' && !obj.computed && obj.property.type === 'Identifier') {
    return obj.property.name;
  }
  return null;
}

function reports(node) {
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'CallExpression') {
    const name = calleeName(node.callee);
    const object = objectName(node.callee);
    if (name && WARN_CALLEES.has(name) && object !== 'console') return true;
    if (name === 'push' && object && /(warnings|failures|errors|diagnostics)$/i.test(object)) {
      return true;
    }
    if (name === 'exit' && object === 'process') return true;
  }
  return false;
}

function anyDescendantReports(node, visitorKeys) {
  if (!node || typeof node.type !== 'string') return false;
  if (reports(node)) return true;
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    const children = Array.isArray(child) ? child : [child];
    for (const c of children) {
      if (c && typeof c.type === 'string' && anyDescendantReports(c, visitorKeys)) return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'a catch block must rethrow, warn, or say why it swallows' },
    messages: {
      unreported:
        'This catch block neither rethrows nor reports a warning. Report it, or add ' +
        '`// lux-intentional-swallow: <reason>` inside it.',
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    const visitorKeys = source.visitorKeys;
    return {
      CatchClause(node) {
        const comments = source.getCommentsInside(node.body);
        if (comments.some((c) => MARKER.test(c.value))) return;
        if (anyDescendantReports(node.body, visitorKeys)) return;
        context.report({ node, messageId: 'unreported' });
      },
    };
  },
};
