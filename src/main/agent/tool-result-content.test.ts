import { describe, expect, it } from 'vitest';
import { renderReadImageSummary, renderToolResultContent, renderToolResultText } from './tool-result-content';

describe('tool result content', () => {
  it('keeps the caption next to the pixels for an image read', () => {
    const content = renderToolResultContent(
      'read',
      { path: 'docs/images/overview.png' },
      {
        kind: 'image',
        mimeType: 'image/png',
        contentBase64: 'AAAA',
        bytes: 3,
        width: 1280,
        height: 720,
      },
    );
    expect(content).toEqual([
      { type: 'text', text: 'docs/images/overview.png: image image/png 1280x720 (3 B).' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('still names the image when the read had no path argument', () => {
    const content = renderToolResultContent('read', undefined, {
      kind: 'image', mimeType: 'image/webp', contentBase64: 'AAAA', bytes: 4,
    });
    expect(content[0]).toEqual({ type: 'text', text: 'image: image image/webp (4 B).' });
  });

  it('decodes a text file result and passes terminal and task output through', () => {
    expect(renderToolResultContent('read', { path: 'a.md' }, {
      kind: 'file', contentBase64: Buffer.from('hello').toString('base64'),
    })).toEqual([{ type: 'text', text: 'hello' }]);
    expect(renderToolResultText('terminal', {
      kind: 'terminal', exitCode: 0, success: true, outputText: 'done', outputTruncated: false,
      terminalId: 't1', outputPath: 'p', shown: true,
    })).toBe('done');
    expect(renderToolResultText('task_get', { kind: 'task', taskId: 't1', outputText: 'snapshot' }))
      .toBe('snapshot');
    expect(renderToolResultText('write', { kind: 'void', message: 'Successfully wrote 3 bytes' }))
      .toBe('Successfully wrote 3 bytes');
    expect(renderToolResultText('write', { kind: 'void' })).toBe('');
  });

  it('scales the reported size so a large image is readable at a glance', () => {
    expect(renderReadImageSummary('a.png', { mimeType: 'image/png', bytes: 4_000 }))
      .toBe('a.png: image image/png (3.9 KiB).');
    expect(renderReadImageSummary('b.png', { mimeType: 'image/png', bytes: 2_500_000 }))
      .toBe('b.png: image image/png (2.4 MiB).');
  });
});
