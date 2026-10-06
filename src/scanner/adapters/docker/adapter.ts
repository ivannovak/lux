import { confinedRead } from '../path-policy.js';
import type { AdapterInputV1 } from '../types.js';
export type DockerFact = {
  family: 'stage' | 'copy' | 'command';
  filePath: string;
  index: number;
  stage: string;
  base?: string;
  from?: string;
  sources?: string[];
  destination?: string;
  instruction?: string;
  argv?: string[];
  static: boolean;
  line: number;
};
export function extractDockerFacts(input: AdapterInputV1) {
  const read = confinedRead(input),
    source = new TextDecoder('utf8', { fatal: true }).decode(read.bytes).replace(/\r\n?/gu, '\n'),
    logical = source.replace(/\\\n/gu, ' '),
    facts: DockerFact[] = [],
    diagnostics: Array<{ code: string; message: string }> = [];
  let stage = 'stage-0',
    index = -1;
  for (const [ln, line] of logical.split('\n').entries()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/iu.exec(text);
    if (from) {
      index++;
      stage = from[2] ?? `stage-${index}`;
      facts.push({
        family: 'stage',
        filePath: input.filePath,
        index,
        stage,
        base: from[1],
        static: !/[${}]/u.test(from[1]),
        line: ln + 1,
      });
      continue;
    }
    const copy = /^(COPY|ADD)\s+(?:--from=(\S+)\s+)?(.+?)\s+(\S+)$/iu.exec(text);
    if (copy) {
      const sources = copy[3].trim().split(/\s+/u);
      const staticValue = ![...sources, copy[4], copy[2] ?? ''].some((v) =>
        /[*$?{}]|^(?:https?|git):/iu.test(v)
      );
      facts.push({
        family: 'copy',
        filePath: input.filePath,
        index,
        stage,
        from: copy[2],
        sources,
        destination: copy[4],
        instruction: copy[1].toUpperCase(),
        static: staticValue,
        line: ln + 1,
      });
      if (!staticValue) diagnostics.push({ code: 'docker-dynamic-copy', message: text });
      continue;
    }
    const cmd = /^(ENTRYPOINT|CMD)\s+(.+)$/iu.exec(text);
    if (cmd)
      facts.push({
        family: 'command',
        filePath: input.filePath,
        index,
        stage,
        instruction: cmd[1].toUpperCase(),
        argv: parseArgv(cmd[2]),
        static: !/[${}`]/u.test(cmd[2]),
        line: ln + 1,
      });
  }
  return { facts, diagnostics };
}
function parseArgv(v: string) {
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) && x.every((item: unknown) => typeof item === 'string') ? x : undefined;
  } catch {
    // lux-intentional-swallow: a non-JSON argv is the shell form, not an error.
    return undefined;
  }
}
