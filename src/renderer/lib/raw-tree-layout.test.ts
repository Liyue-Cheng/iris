import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '../components/lens/RawTree.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const externalSectionSource = readFileSync(
  resolve(__dirname, '../components/lens/ExternalSection.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('RawTree row alignment', () => {
  it('keeps directory titles left-aligned like file titles', () => {
    expect(source).toContain(
      'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[13px] text-foreground/85',
    );
  });

  it('keeps the original RawTree file and folder icons on the left', () => {
    expect(source).toContain('<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />');
    expect(source).toContain('<File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />');
    expect(source).toContain(
      '<Folder className="h-3.5 w-3.5 text-muted-foreground" />\n        <span className="min-w-0 flex-1 truncate">{node.name}</span>',
    );
  });

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
