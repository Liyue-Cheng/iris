/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const externalSectionSource = readFileSync(
  resolve(__dirname, '../components/lens/ExternalSection.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('RawTree row alignment', () => {
  it('aligns External names with document rows while keeping the folder icon at the row end', () => {
    expect(externalSectionSource).not.toContain("entry.kind === 'directory' ? Folder : File");
    expect(externalSectionSource).toContain(
      '<span className="flex w-3 shrink-0 items-center justify-center">',
    );
    expect(externalSectionSource).toContain(
      '<span className="min-w-0 flex-1 truncate">{entry.name}</span>\n      {!entry.error && entry.kind === \'directory\' && (\n        <Folder',
    );
  });

  it('keeps the left-pane External section title in fixed English', () => {
    expect(externalSectionSource).toContain('          External\n');
    expect(externalSectionSource).not.toContain("t('external.title')");
  });

  it('relies on automatic projection updates without a manual refresh control', () => {
    expect(externalSectionSource).not.toContain('RefreshCw');
    expect(externalSectionSource).not.toContain("aria-label={t('common.refresh')}");
  });
});
