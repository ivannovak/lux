// The progress and warning sinks are distinct branded types, so handing one to a parameter that
// wants the other is a compile error, not a runtime surprise (issue #6). Each `@ts-expect-error`
// below is this guard's self-check: if a brand stopped separating the types, the line would compile,
// the directive would go unused, and `tsc --noEmit` would fail.

import { describe, it, expect } from 'vitest';
import { progressSink, warnSink, type ProgressFn, type WarnFn } from '../reporter.js';

function wantsWarn(warn: WarnFn): WarnFn {
  return warn;
}

function wantsProgress(progress: ProgressFn): ProgressFn {
  return progress;
}

describe('reporter brands', () => {
  it('separate progress sinks from warning sinks at compile time', () => {
    const progress = progressSink(() => {});
    const warn = warnSink(() => {});
    const plain = (message: string): void => {
      void message;
    };
    const alias: (message: string) => void = progress;

    // @ts-expect-error a progress logger is not a warning sink
    wantsWarn(progress);
    // @ts-expect-error nor is an unbranded callback
    wantsWarn(plain);
    // @ts-expect-error nor an alias that has lost the brand
    wantsWarn(alias);
    // @ts-expect-error nor a callback built on the spot
    wantsWarn((message: string) => alias(message));
    // @ts-expect-error a warning sink is not a progress logger either
    wantsProgress(warn);

    expect(wantsWarn(warn)).toBe(warn);
    expect(wantsProgress(progress)).toBe(progress);
  });
});
