import { parse } from 'yaml';
import type { SourceDiagnosticV1, SourceLocationV1 } from '../../contracts/program.js';
import { confinedRead } from '../path-policy.js';
import type { AdapterInputV1 } from '../types.js';
import { staticActionScalar } from './static-expression.js';
export interface ActionFact {
  family: 'workflow' | 'job' | 'step' | 'uses' | 'run' | 'artifact';
  filePath: string;
  localId: string;
  ownerLocalId?: string;
  value?: string;
  operation?: 'upload' | 'download';
  location: SourceLocationV1;
}
export function extractActionFacts(input: AdapterInputV1) {
  if (!/\.github\/workflows\/[^/]+\.ya?ml$/u.test(input.filePath.replaceAll('\\', '/')))
    return {
      facts: [],
      diagnostics: [{ code: 'actions-path-refused', message: 'not a workflow path' }],
    };
  const read = confinedRead(input),
    source = new TextDecoder('utf8', { fatal: true }).decode(read.bytes);
  let doc: unknown;
  try {
    doc = parse(source, { schema: 'core', uniqueKeys: true, merge: false, maxAliasCount: 20 });
  } catch (error) {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return {
      facts: [],
      diagnostics: [
        {
          code: 'actions-yaml-invalid',
          message: error instanceof Error ? error.message : 'invalid YAML',
        },
      ],
    };
  }
  const facts: ActionFact[] = [],
    diagnostics: SourceDiagnosticV1[] = [],
    filePath = input.filePath.replaceAll('\\', '/'),
    root = doc as Record<string, unknown>,
    workflow = `workflow:${filePath}`;
  facts.push({
    family: 'workflow',
    filePath,
    localId: workflow,
    location: { filePath, line: 1, column: 0 },
  });
  const jobs = root.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return { facts, diagnostics };
  for (const [jobId, value] of Object.entries(jobs as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const job = `${workflow}:job:${jobId}`,
      j = value as Record<string, unknown>;
    facts.push({
      family: 'job',
      filePath,
      localId: job,
      ownerLocalId: workflow,
      value: jobId,
      location: loc(source, filePath, jobId),
    });
    const reusable = staticActionScalar(j.uses);
    if (reusable)
      facts.push({
        family: 'uses',
        filePath,
        localId: `${job}:uses`,
        ownerLocalId: job,
        value: reusable,
        location: loc(source, filePath, reusable),
      });
    const steps = Array.isArray(j.steps) ? j.steps : [];
    steps.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const s = raw as Record<string, unknown>,
        stepName = typeof s.id === 'string' ? s.id : String(index),
        step = `${job}:step:${stepName}`;
      facts.push({
        family: 'step',
        filePath,
        localId: step,
        ownerLocalId: job,
        value: stepName,
        location: loc(
          source,
          filePath,
          typeof s.id === 'string' ? s.id : typeof s.name === 'string' ? s.name : String(index)
        ),
      });
      const uses = staticActionScalar(s.uses);
      if (uses)
        facts.push({
          family: 'uses',
          filePath,
          localId: `${step}:uses`,
          ownerLocalId: step,
          value: uses,
          location: loc(source, filePath, uses),
        });
      else if (s.uses !== undefined)
        diagnostics.push({
          code: 'actions-computed-target',
          message: 'Computed uses target.',
          location: loc(source, filePath, 'uses'),
        });
      const run = staticActionScalar(s.run);
      if (run && !/[|;&><`$]/u.test(run))
        facts.push({
          family: 'run',
          filePath,
          localId: `${step}:run`,
          ownerLocalId: step,
          value: run.split(/\s+/u)[0],
          location: loc(source, filePath, run),
        });
      if (uses === 'actions/upload-artifact@v4' || uses === 'actions/download-artifact@v4') {
        const withValue = s.with;
        if (withValue && typeof withValue === 'object' && !Array.isArray(withValue)) {
          const name = staticActionScalar((withValue as Record<string, unknown>).name);
          if (name)
            facts.push({
              family: 'artifact',
              filePath,
              localId: `${step}:artifact:${name}`,
              ownerLocalId: step,
              value: name,
              operation: uses.includes('upload') ? 'upload' : 'download',
              location: loc(source, filePath, name),
            });
        }
      }
    });
  }
  return { facts, diagnostics };
}
function loc(source: string, filePath: string, text: string): SourceLocationV1 {
  const i = Math.max(0, source.indexOf(text)),
    before = source.slice(0, i),
    line = before.split('\n').length,
    column = i - (before.lastIndexOf('\n') + 1);
  return { filePath, line, column };
}
