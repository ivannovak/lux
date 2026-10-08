import type {
  AttributeNode,
  CompilerError,
  DirectiveNode,
  ElementNode,
  RootNode,
  TemplateChildNode,
} from '@vue/compiler-dom';
import { vueDomCompiler } from './compilers.js';
import type { SourceDiagnosticV1 } from '../contracts/program.js';
import { sourceLocationAt } from './source-map.js';
import type { VueTemplateElementV1, VueTemplateListenerV1 } from './types.js';

const HTML_TAGS = new Set(
  'html body base head link meta style title address article aside footer header h1 h2 h3 h4 h5 h6 nav section div dd dl dt figcaption figure picture hr img li main ol p pre ul a b abbr bdi bdo br cite code data dfn em i kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr area audio map track video embed object param source canvas script noscript del ins caption col colgroup table tbody td tfoot th thead tr button datalist fieldset form input label legend meter optgroup option output progress select textarea details dialog menu summary template blockquote iframe tfoot svg animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect set stop switch symbol text textPath tspan use view'.split(
    ' '
  )
);
const BUILT_INS = new Set([
  'component',
  'slot',
  'template',
  'teleport',
  'suspense',
  'keepalive',
  'transition',
  'transitiongroup',
]);

export interface VueTemplateLimitsV1 {
  maxNodes: number;
  maxDepth: number;
  maxReferences: number;
}

export interface VueTemplateExtractionV1 {
  elements: VueTemplateElementV1[];
  listeners: VueTemplateListenerV1[];
  diagnostics: SourceDiagnosticV1[];
  compilerDiagnostics: SourceDiagnosticV1[];
  nodeCount: number;
}

function diagnosticLocation(
  filePath: string,
  sfcSource: string,
  templateStartOffset: number,
  offset: number
) {
  return sourceLocationAt(filePath, sfcSource, templateStartOffset + offset);
}

function compilerDiagnostic(
  error: CompilerError,
  filePath: string,
  sfcSource: string,
  templateStartOffset: number
): SourceDiagnosticV1 {
  return {
    code: `vue-template-${String(error.code)}`,
    message: error.message,
    ...(error.loc
      ? {
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            error.loc.start.offset
          ),
        }
      : {}),
  };
}

function normalizedBuiltIn(tag: string): string {
  return tag.replaceAll('-', '').toLowerCase();
}

function isComponentTag(tag: string): boolean {
  return !HTML_TAGS.has(tag) && !BUILT_INS.has(normalizedBuiltIn(tag));
}

function attribute(node: ElementNode, name: string): AttributeNode | undefined {
  return node.props.find(
    (prop): prop is AttributeNode =>
      prop.type === vueDomCompiler().NodeTypes.ATTRIBUTE && prop.name === name
  );
}

function directive(node: ElementNode, name: string): DirectiveNode[] {
  return node.props.filter(
    (prop): prop is DirectiveNode =>
      prop.type === vueDomCompiler().NodeTypes.DIRECTIVE && prop.name === name
  );
}

function staticArgument(item: DirectiveNode): string | undefined {
  return item.arg?.type === vueDomCompiler().NodeTypes.SIMPLE_EXPRESSION && item.arg.isStatic
    ? item.arg.content
    : undefined;
}

function childrenOf(node: RootNode | TemplateChildNode): readonly TemplateChildNode[] {
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.filter((child): child is TemplateChildNode => typeof child !== 'string');
  }
  if (node.type === vueDomCompiler().NodeTypes.IF)
    return node.branches.flatMap((branch) => branch.children);
  return [];
}

/** Parse an exact SFC template content slice and map all observations to the original `.vue`. */
export function extractVueTemplate(
  filePath: string,
  sfcSource: string,
  templateStartOffset: number,
  templateSource: string,
  limits: VueTemplateLimitsV1
): VueTemplateExtractionV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const compilerDiagnostics: SourceDiagnosticV1[] = [];
  const elements: VueTemplateElementV1[] = [];
  const listeners: VueTemplateListenerV1[] = [];
  let root: RootNode;

  try {
    root = vueDomCompiler().parse(templateSource, {
      onError(error) {
        compilerDiagnostics.push(
          compilerDiagnostic(error, filePath, sfcSource, templateStartOffset)
        );
      },
      onWarn(warning) {
        compilerDiagnostics.push(
          compilerDiagnostic(warning, filePath, sfcSource, templateStartOffset)
        );
      },
    });
  } catch (error) {
    compilerDiagnostics.push({
      code: 'vue-template-parse-error',
      message: error instanceof Error ? error.message : 'Vue template parser failed',
      location: sourceLocationAt(filePath, sfcSource, templateStartOffset),
    });
    return { elements, listeners, diagnostics, compilerDiagnostics, nodeCount: 0 };
  }

  const pending: Array<{ node: RootNode | TemplateChildNode; depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodeCount = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      diagnostics.push({
        code: 'limit',
        message: 'Vue template syntax node count exceeds maxNodes.',
        location: sourceLocationAt(filePath, sfcSource, templateStartOffset),
      });
      break;
    }
    if (item.depth > limits.maxDepth) {
      diagnostics.push({
        code: 'limit',
        message: 'Vue template syntax depth exceeds maxDepth.',
        location: sourceLocationAt(filePath, sfcSource, templateStartOffset),
      });
      break;
    }
    for (const child of [...childrenOf(item.node)].reverse()) {
      pending.push({ node: child, depth: item.depth + 1 });
    }
    if (item.node.type !== vueDomCompiler().NodeTypes.ELEMENT) continue;

    const element = item.node;
    const location = diagnosticLocation(
      filePath,
      sfcSource,
      templateStartOffset,
      element.loc.start.offset
    );
    let acceptedTarget = isComponentTag(element.tag);
    if (element.tag === 'component') {
      const literalIs = attribute(element, 'is')?.value?.content;
      const dynamicIs = directive(element, 'bind').find(
        (entry) => staticArgument(entry) === 'is' || entry.arg === undefined
      );
      if (literalIs) {
        elements.push({ tag: element.tag, staticIs: literalIs, location });
        acceptedTarget = true;
      } else if (dynamicIs) {
        diagnostics.push({
          code: 'vue-dynamic-component',
          message: 'Dynamic component :is cannot produce a static component relationship.',
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            dynamicIs.loc.start.offset
          ),
        });
      }
    } else if (acceptedTarget) {
      elements.push({ tag: element.tag, location });
    }

    for (const on of directive(element, 'on')) {
      const eventName = staticArgument(on);
      if (on.arg === undefined || !eventName) {
        diagnostics.push({
          code: on.arg === undefined ? 'vue-object-listener' : 'vue-dynamic-event',
          message:
            on.arg === undefined
              ? 'Object v-on cannot produce a static listener relationship.'
              : 'Dynamic event arguments cannot produce a static listener relationship.',
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            on.loc.start.offset
          ),
        });
      } else if (acceptedTarget) {
        listeners.push({
          childTag: element.tag,
          eventName,
          ...(on.exp?.loc.source ? { handler: on.exp.loc.source } : {}),
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            on.loc.start.offset
          ),
        });
      }
    }

    for (const model of directive(element, 'model')) {
      const argument = model.arg === undefined ? undefined : staticArgument(model);
      if (model.arg !== undefined && !argument) {
        diagnostics.push({
          code: 'vue-dynamic-model',
          message: 'Dynamic v-model arguments cannot produce a static listener relationship.',
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            model.loc.start.offset
          ),
        });
      } else if (acceptedTarget) {
        listeners.push({
          childTag: element.tag,
          eventName: `update:${argument ?? 'modelValue'}`,
          ...(model.exp?.loc.source ? { handler: model.exp.loc.source } : {}),
          ...(argument ? { modelArgument: argument } : {}),
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            model.loc.start.offset
          ),
        });
      }
    }

    for (const bind of directive(element, 'bind')) {
      const argument = staticArgument(bind);
      if (
        acceptedTarget &&
        argument &&
        bind.modifiers.some((modifier) => modifier.content === 'sync')
      ) {
        listeners.push({
          childTag: element.tag,
          eventName: `update:${argument}`,
          ...(bind.exp?.loc.source ? { handler: bind.exp.loc.source } : {}),
          modelArgument: argument,
          location: diagnosticLocation(
            filePath,
            sfcSource,
            templateStartOffset,
            bind.loc.start.offset
          ),
        });
      }
    }
  }

  if (elements.length + listeners.length > limits.maxReferences) {
    diagnostics.push({
      code: 'limit',
      message: 'Vue template facts exceed maxReferences.',
      location: sourceLocationAt(filePath, sfcSource, templateStartOffset),
    });
    elements.length = 0;
    listeners.length = 0;
  }
  diagnostics.push(...compilerDiagnostics);
  return { elements, listeners, diagnostics, compilerDiagnostics, nodeCount };
}
