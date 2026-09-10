import { describe, expect, it } from 'vitest';
import {
  emptyTextEditSelection,
  isTextEditActionDisabled,
  readTextEditSelection,
  type TextEditSelection,
} from './text-edit-menu';

const selection = (patch: Partial<TextEditSelection> = {}): TextEditSelection => ({
  ...emptyTextEditSelection(),
  ...patch,
});

describe('readTextEditSelection', () => {
  it('reports an empty snapshot when there is no target', () => {
    expect(readTextEditSelection(null)).toEqual(emptyTextEditSelection());
  });

  it('captures the caret range of a collapsed selection', () => {
    expect(readTextEditSelection({ value: 'hello', selectionStart: 3, selectionEnd: 3 })).toEqual({
      start: 3,
      end: 3,
      hasSelection: false,
      hasText: true,
    });
  });

  it('captures a non-empty selection', () => {
    expect(readTextEditSelection({ value: 'hello', selectionStart: 1, selectionEnd: 4 })).toEqual({
      start: 1,
      end: 4,
      hasSelection: true,
      hasText: true,
    });
  });

  it('tolerates controls that report no selection range', () => {
    expect(readTextEditSelection({ value: '', selectionStart: null, selectionEnd: null })).toEqual({
      start: 0,
      end: 0,
      hasSelection: false,
      hasText: false,
    });
  });
});

describe('isTextEditActionDisabled', () => {
  it('requires a selection for cut and copy', () => {
    const caret = selection({ start: 2, end: 2, hasText: true });
    expect(isTextEditActionDisabled('cut', caret)).toBe(true);
    expect(isTextEditActionDisabled('copy', caret)).toBe(true);
    const selected = selection({ start: 2, end: 5, hasSelection: true, hasText: true });
    expect(isTextEditActionDisabled('cut', selected)).toBe(false);
    expect(isTextEditActionDisabled('copy', selected)).toBe(false);
  });

  it('keeps paste available regardless of selection', () => {
    expect(isTextEditActionDisabled('paste', emptyTextEditSelection())).toBe(false);
    expect(isTextEditActionDisabled('paste', selection({ hasText: true }))).toBe(false);
  });

  it('disables select-all only on an empty field', () => {
    expect(isTextEditActionDisabled('selectAll', emptyTextEditSelection())).toBe(true);
    expect(isTextEditActionDisabled('selectAll', selection({ start: 1, hasText: true }))).toBe(false);
  });
});
