/**
 * Rose Pine syntax highlighting for CodeMirror 6, shared by both the WYSIWYG
 * code blocks (Crepe's CodeMirror feature) and the source-mode editor.
 *
 * The colors are written as `var(--rp-*)`, NOT hex literals: HighlightStyle
 * compiles each spec into a CSS class, and the var() is resolved against the
 * live cascade at paint time. That means one definition follows all three
 * Rose Pine variants (base / dawn / moon) automatically — the same var()
 * indirection the Crepe re-theme uses in global.css — and a theme switch
 * (documentElement.dataset.theme) re-colors code instantly, no remount.
 *
 * Loaded AFTER basicSetup so it overrides CodeMirror's light defaultHighlightStyle.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

const rosePineHighlightStyle = HighlightStyle.define([
  // Comments — muted + italic.
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--rp-muted)', fontStyle: 'italic' },

  // Keywords / modifiers — pine.
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null],
    color: 'var(--rp-pine)',
  },

  // Strings / regexp / escapes — gold.
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.character], color: 'var(--rp-gold)' },

  // Numbers / booleans / atoms / constants — rose.
  { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.unit, t.constant(t.name)], color: 'var(--rp-rose)' },

  // Function names & calls — rose (warm accent, distinct from types).
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: 'var(--rp-rose)' },

  // Types / classes / namespaces / tags — foam.
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.tagName)], color: 'var(--rp-foam)' },

  // Properties / attributes — foam (slightly cooler than plain identifiers).
  { tag: [t.propertyName, t.attributeName], color: 'var(--rp-foam)' },

  // Plain identifiers / variables — text.
  { tag: [t.variableName, t.attributeValue], color: 'var(--rp-text)' },

  // Operators / punctuation / brackets — subtle.
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.bitwiseOperator, t.punctuation, t.separator, t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket], color: 'var(--rp-subtle)' },

  // Links / urls — iris, underlined.
  { tag: [t.link, t.url], color: 'var(--rp-iris)', textDecoration: 'underline' },

  // Meta / processing instructions — muted.
  { tag: [t.meta, t.documentMeta, t.processingInstruction, t.annotation], color: 'var(--rp-muted)' },

  // Markdown structure (source mode): headings bold, emphasis italic, strong bold.
  { tag: [t.heading], color: 'var(--rp-iris)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.monospace], color: 'var(--rp-love)' },

  // Invalid / errors — love.
  { tag: t.invalid, color: 'var(--rp-love)' },
]);

/**
 * Drop-in extension: Rose Pine highlight + a transparent editor surface
 * (Crepe paints the code-block background) + the project mono stack.
 */
export const rosePineCodeMirror: Extension = [
  syntaxHighlighting(rosePineHighlightStyle),
  EditorView.theme({
    '&': { backgroundColor: 'transparent' },
    '.cm-content': {
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
    },
    // Gutter (line numbers): basicSetup ships CodeMirror's default light
    // gutter (near-white digits on a pale strip), which ignores the theme.
    // Pin it to Rose Pine via var() so it follows base/dawn/moon and recolors
    // on theme switch — same indirection as the highlight style above.
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--rp-muted)',
      border: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { color: 'var(--rp-muted)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--rp-subtle)',
    },
  }),
];
