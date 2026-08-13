import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IRIS_AGENT_PROMPT } from './prompt';
import { createIrisPiResourceLoader, createIrisPiToolDefinitions } from './pi-adapter';

describe('Iris Pi adapter', () => {
  it('loads only the built-in Iris prompt and no discovered Pi resources', async () => {
    const root = process.cwd();
    const loader = await createIrisPiResourceLoader(root, join(root, '.not-used-pi-agent'));
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPrompt()).toBe(IRIS_AGENT_PROMPT);
  });

  it('exposes only wrapped public Pi tool definitions and delegates operations', async () => {
    const root = process.cwd();
    const operations = {
      read: { access: vi.fn(async () => {}), readFile: vi.fn(async () => Buffer.from('hello')) },
      edit: {
        access: vi.fn(async () => {}),
        readFile: vi.fn(async () => Buffer.from('before')),
        writeFile: vi.fn(async () => {}),
      },
      write: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) },
      terminal: {
        exec: vi.fn(async (_command, _cwd, options) => {
          options.onData(Buffer.from('terminal output'));
          return { exitCode: 0 };
        }),
      },
    };
    const tools = createIrisPiToolDefinitions(root, operations);
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'edit', 'write', 'terminal']);
    const read = tools[0]!;
    const result = await read.execute(
      'call-1',
      { path: 'README.md' },
      undefined,
      undefined,
      {} as never,
    );
    expect(operations.read.readFile).toHaveBeenCalledWith(join(root, 'README.md'));
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(tools[3]!.promptGuidelines).toEqual([]);
  });
});

