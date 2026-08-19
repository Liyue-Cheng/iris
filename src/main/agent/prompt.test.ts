import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROMPT,
  IRIS_AGENT_PROMPT_METADATA,
  assembleAgentPrompt,
  assembleLatestAgentPrompt,
  effectivePiPromptFingerprint,
} from './prompt';

describe('Iris Agent canonical prompt', () => {
  it('keeps the reviewed Pi adaptation narrow and fingerprinted', () => {
    expect(IRIS_AGENT_PROMPT).toContain('operating inside Iris Agent');
    expect(IRIS_AGENT_PROMPT).toContain('- terminal: Execute a visible command');
    expect(IRIS_AGENT_PROMPT).toContain('edits[].oldText is matched against the original file');
    expect(IRIS_AGENT_PROMPT).not.toMatch(/Pi documentation|PI_|custom tools|extensions|skills|TUI/);
    expect(IRIS_AGENT_PROMPT_METADATA.upstreamVersion).toBe('0.84.1');
    expect(IRIS_AGENT_PROMPT_METADATA.adaptedBasePromptSha256).toBe(
      'e50340a52873692bf07e2ad3e59be4cfaa4e937de2bcbbeb3d46cd32a6deb093',
    );
    expect(IRIS_AGENT_PROMPT_METADATA.finalPromptSha256).toBe(
      effectivePiPromptFingerprint(IRIS_AGENT_PROMPT, IRIS_AGENT_PROMPT_METADATA.finalPromptCwd),
    );
    expect(IRIS_AGENT_PROMPT_METADATA.finalPromptSha256).not.toBe(
      IRIS_AGENT_PROMPT_METADATA.adaptedBasePromptSha256,
    );
  });

  it('assembles distinguishable layers in fixed order and escapes anchor paths', () => {
    const result = assembleAgentPrompt({
      software: 'software-v1',
      project: 'project-v2',
      anchor: { path: '.iris/issue/a&b".md', text: 'latest issue snapshot' },
    });
    expect(result.text).toMatch(
      /<iris-agent-base[\s\S]*<iris-software>[\s\S]*<iris-project>[\s\S]*<iris-anchor/,
    );
    expect(result.text).toContain('path=".iris/issue/a&amp;b&quot;.md"');
    expect(new Set(Object.values(result.layerFingerprints)).size).toBe(4);
  });

  it('flushes before reading the latest canonical sources', async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push('flush');
    });
    const readSources = vi.fn(async () => {
      order.push('read');
      return { software: 's', project: 'p', anchor: { workspacePath: '.iris', text: 'hub' } };
    });
    await assembleLatestAgentPrompt({ flush, readSources });
    expect(order).toEqual(['flush', 'read']);
  });
});
