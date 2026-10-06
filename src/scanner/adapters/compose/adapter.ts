import { parse } from 'yaml';
import { confinedRead } from '../path-policy.js';
import type { AdapterInputV1 } from '../types.js';
export type ComposeFact = {
  family: 'service' | 'image' | 'build' | 'dependency';
  filePath: string;
  service: string;
  value?: string;
  context?: string;
  dockerfile?: string;
  line: number;
};
export function extractComposeFacts(input: AdapterInputV1) {
  const source = new TextDecoder('utf8', { fatal: true }).decode(confinedRead(input).bytes);
  let root: unknown;
  try {
    root = parse(source, { schema: 'core', uniqueKeys: true, merge: false, maxAliasCount: 20 });
  } catch (error) {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return {
      facts: [],
      diagnostics: [
        {
          code: 'compose-yaml-invalid',
          message: error instanceof Error ? error.message : 'invalid',
        },
      ],
    };
  }
  const facts: ComposeFact[] = [],
    diagnostics: Array<{ code: string; message: string }> = [],
    services = (root as Record<string, unknown>)?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services))
    return { facts, diagnostics };
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (/[${}]/u.test(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push({ code: 'compose-dynamic-service', message: name });
      continue;
    }
    const value = raw as Record<string, unknown>;
    facts.push({
      family: 'service',
      filePath: input.filePath,
      service: name,
      line: line(source, name),
    });
    if (typeof value.image === 'string' && !/[${}]/u.test(value.image))
      facts.push({
        family: 'image',
        filePath: input.filePath,
        service: name,
        value: value.image,
        line: line(source, value.image),
      });
    const build = value.build;
    if (typeof build === 'string' && !/[${}]/u.test(build))
      facts.push({
        family: 'build',
        filePath: input.filePath,
        service: name,
        context: build,
        dockerfile: 'Dockerfile',
        line: line(source, build),
      });
    else if (build && typeof build === 'object' && !Array.isArray(build)) {
      const b = build as Record<string, unknown>,
        context = typeof b.context === 'string' ? b.context : undefined,
        dockerfile = typeof b.dockerfile === 'string' ? b.dockerfile : 'Dockerfile';
      if (
        context &&
        dockerfile &&
        ![context, dockerfile].some((v) => /[${}]|(^|\/)\.\.($|\/)|^\//u.test(v))
      )
        facts.push({
          family: 'build',
          filePath: input.filePath,
          service: name,
          context,
          dockerfile,
          line: line(source, context),
        });
    }
    const dep = value.depends_on;
    if (Array.isArray(dep))
      for (const d of dep)
        if (typeof d === 'string' && !/[${}]/u.test(d))
          facts.push({
            family: 'dependency',
            filePath: input.filePath,
            service: name,
            value: d,
            line: line(source, d),
          });
        else;
    else if (dep && typeof dep === 'object')
      for (const d of Object.keys(dep))
        if (!/[${}]/u.test(d))
          facts.push({
            family: 'dependency',
            filePath: input.filePath,
            service: name,
            value: d,
            line: line(source, d),
          });
  }
  return { facts, diagnostics };
}
function line(s: string, t: string) {
  return s.slice(0, Math.max(0, s.indexOf(t))).split('\n').length;
}
