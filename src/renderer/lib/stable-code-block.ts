import {
  CodeMirrorBlock,
  codeBlockConfig,
  type CodeBlockConfig,
} from '@milkdown/kit/component/code-block';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { $view } from '@milkdown/kit/utils';

const RETAINED_CODE_BLOCK = Symbol('iris.retained-code-block');

type LanguageDescription = CodeBlockConfig['languages'][number];

/**
 * Milkdown does not export the loader used by CodeMirrorBlock. Keep the small
 * adapter local so Iris can own the NodeView factory without copying the
 * upstream code-block UI implementation.
 */
class LanguageLoader {
  private readonly byAlias = new Map<string, LanguageDescription>();

  constructor(private readonly languages: LanguageDescription[]) {
    languages.forEach((language) => {
      language.alias.forEach((alias) => this.byAlias.set(alias, language));
    });
  }

  getAll(): Array<{ name: string; alias: readonly string[] }> {
    return this.languages.map(({ name, alias }) => ({ name, alias }));
  }

  load(languageName: string) {
    const language = this.byAlias.get(languageName.toLowerCase());
    if (!language) return Promise.resolve(undefined);
    if (language.support) return Promise.resolve(language.support);
    return language.load();
  }
}

/**
 * Retain one initialized CodeMirror instance until its ProseMirror NodeView is
 * destroyed. Milkdown still controls the initial lazy mount through its
 * IntersectionObserver; Iris controls whether an initialized editor is later
 * replaced by a placeholder.
 */
export function retainInitializedCodeBlock(block: object): void {
  if (Reflect.get(block, RETAINED_CODE_BLOCK) === true) return;

  const scheduleTeardown = Reflect.get(block, 'scheduleTeardown');
  if (typeof scheduleTeardown !== 'function') {
    throw new Error('Unsupported Milkdown code-block lifecycle: scheduleTeardown is missing');
  }

  Object.defineProperty(block, 'scheduleTeardown', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (): void => {},
  });
  Object.defineProperty(block, RETAINED_CODE_BLOCK, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
}

/**
 * Registered after Crepe's built-in code-block view, so this factory wins the
 * duplicate code_block key when Milkdown constructs ProseMirror's nodeViews.
 */
export const stableCodeBlockView = $view(codeBlockSchema.node, (ctx) => {
  const config = ctx.get(codeBlockConfig.key);
  const loader = new LanguageLoader(config.languages);

  return (node, view, getPos) => {
    // CodeMirrorBlock's loader type is private to @milkdown/components, even
    // though its constructor is public. This local adapter has the same API.
    const block = new CodeMirrorBlock(node, view, getPos, loader as never, config);
    retainInitializedCodeBlock(block);
    return block;
  };
});
