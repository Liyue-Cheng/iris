import { describe, expect, it } from 'vitest';
import { JtpMcpProvider, discoverMcpDescriptors, mcpJtpToolId } from './mcp-provider';

describe('JtpMcpProvider', () => {
  it('uses JTP ids for discovered MCP tools', async () => {
    const provider = new JtpMcpProvider({ id: 'github', command: 'node' });
    provider.listTools = async () => [{ name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object' } }];
    const descriptors = await discoverMcpDescriptors(provider, 'github');
    expect(descriptors[0]).toMatchObject({ id: mcpJtpToolId('github', 'create_issue'), provider: 'mcp:github' });
  });
});
