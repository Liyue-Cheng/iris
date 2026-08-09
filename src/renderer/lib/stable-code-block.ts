import {
  CodeMirrorBlock,
  codeBlockConfig,
  type CodeBlockConfig,
} from '@milkdown/kit/component/code-block';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { $view } from '@milkdown/kit/utils';

const RETAINED_CODE_BLOCK = Symbol('iris.retained-code-block');
const COPY_FEEDBACK_ATTRIBUTE = 'data-copy-feedback';

export const CODE_BLOCK_COPY_FEEDBACK_MS = 1500;

type LanguageDescription = CodeBlockConfig['languages'][number];

/**
 * Milkdown owns the copy button markup, so keep the transient success state
 * outside its Vue component and address each code block button independently.
 */
export function attachCodeBlockCopyFeedback(
  root: HTMLElement,
  resetAfterMs = CODE_BLOCK_COPY_FEEDBACK_MS,
): () => void {
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  const handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest<HTMLButtonElement>(
      '.milkdown-code-block .copy-button',
    );
    if (!button || !root.contains(button)) return;

    const previousTimer = timers.get(button);
    if (previousTimer !== undefined) clearTimeout(previousTimer);

    button.setAttribute(COPY_FEEDBACK_ATTRIBUTE, 'copied');
    const timer = setTimeout(() => {
      button.removeAttribute(COPY_FEEDBACK_ATTRIBUTE);
      timers.delete(button);
    }, resetAfterMs);
    timers.set(button, timer);
  };

  root.addEventListener('click', handleClick);

  return () => {
    root.removeEventListener('click', handleClick);
    timers.forEach((timer, button) => {
      clearTimeout(timer);
      button.removeAttribute(COPY_FEEDBACK_ATTRIBUTE);
    });
    timers.clear();
  };
}

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
 * destroyed, and keep selection offsets inside the current code document.
 * Milkdown still controls the initial lazy mount through its IntersectionObserver;
 * Iris controls later teardown and guards its unbounded selection bridge.
 */
export function retainInitializedCodeBlock(block: object): void {
  if (Reflect.get(block, RETAINED_CODE_BLOCK) === true) return;

  const scheduleTeardown = Reflect.get(block, 'scheduleTeardown');
  const setSelection = Reflect.get(block, 'setSelection');
  if (typeof scheduleTeardown !== 'function') {
    throw new Error('Unsupported Milkdown code-block lifecycle: scheduleTeardown is missing');
  }
  if (typeof setSelection !== 'function') {
    throw new Error('Unsupported Milkdown code-block lifecycle: setSelection is missing');
  }

  Object.defineProperty(block, 'scheduleTeardown', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (): void => {},
  });
  Object.defineProperty(block, 'setSelection', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(this: object, anchor: number, head: number): void {
      const node = Reflect.get(this, 'node');
      const text = Reflect.get(node ?? {}, 'textContent');
      const length = typeof text === 'string' ? text.length : 0;
      const clamp = (position: number): number => Math.max(0, Math.min(position, length));
      Reflect.apply(setSelection, this, [clamp(anchor), clamp(head)]);
    },
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
