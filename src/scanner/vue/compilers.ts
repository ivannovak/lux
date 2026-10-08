// The Vue compilers, loaded on first use.
//
// @vue/compiler-sfc takes about 90 ms to load and @vue/compiler-dom, which it includes, about 25 ms.
// Every `lux` command imports the modules that parse Vue, and most never parse any: a search, a
// trace or a repository without Vue files would pay that on each run.

import { createRequire } from 'node:module';

type CompilerSfc = typeof import('@vue/compiler-sfc');
type CompilerDom = typeof import('@vue/compiler-dom');

const require = createRequire(import.meta.url);
let compilerSfc: CompilerSfc | undefined;
let compilerDom: CompilerDom | undefined;

export function vueSfcCompiler(): CompilerSfc {
  return (compilerSfc ??= require('@vue/compiler-sfc') as CompilerSfc);
}

export function vueDomCompiler(): CompilerDom {
  return (compilerDom ??= require('@vue/compiler-dom') as CompilerDom);
}
