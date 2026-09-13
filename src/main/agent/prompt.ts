import { createHash } from 'node:crypto';
export const IRIS_AGENT_PROMPT = `You are an expert coding assistant operating inside Iris Agent. Help users complete software and project-management tasks using the capabilities available in your current context.

Guidelines:
- Follow the project's software and project instructions.
- Make precise, reviewable changes and verify them with appropriate checks.
- Preserve user data and report failures clearly.
- Be concise in your responses and show file paths clearly when working with files.`;
export const IRIS_AGENT_PROMPT_METADATA = { upstreamPackage: '@earendil-works/pi-ai', upstreamVersion: '0.84.1', upstreamPromptCwd: 'C:/iris-prompt-root', upstreamPromptSha256: 'bfd83ad660a7f76ee86a8beee63c80eda1441be7f717ae156dedaf0029c85293', adaptationVersion: 6, adaptation: ['tool semantics supplied by JTP descriptors'], adaptedBasePromptSha256: sha256(IRIS_AGENT_PROMPT), finalPromptCwd: 'C:/iris-prompt-root', finalPromptSha256: effectivePiPromptFingerprint(IRIS_AGENT_PROMPT, 'C:/iris-prompt-root') } as const;
export interface CanonicalPromptSources { software: string; project: string; anchor: { path: string; text: string } | { workspacePath: string; text: string }; }
export interface CanonicalPromptAssembler { flush(): Promise<void>; readSources(): Promise<CanonicalPromptSources>; }
export interface AssembledAgentPrompt { text: string; fingerprint: string; layerFingerprints: { agent: string; software: string; project: string; anchor: string; }; }
export async function assembleLatestAgentPrompt(source: CanonicalPromptAssembler): Promise<AssembledAgentPrompt> { await source.flush(); return assembleAgentPrompt(await source.readSources()); }
export function assembleAgentPrompt(sources: CanonicalPromptSources): AssembledAgentPrompt { const anchor = 'path' in sources.anchor ? `kind="document" path="${escapeAttribute(sources.anchor.path)}"` : `kind="workspace" path="${escapeAttribute(sources.anchor.workspacePath)}"`; const layers = { agent: IRIS_AGENT_PROMPT, software: sources.software, project: sources.project, anchor: sources.anchor.text }; const text = [`<iris-agent-base version="6">\n${layers.agent}\n</iris-agent-base>`, `<iris-software>\n${layers.software}\n</iris-software>`, `<iris-project>\n${layers.project}\n</iris-project>`, `<iris-anchor ${anchor}>\n${layers.anchor}\n</iris-anchor>`].join('\n\n'); return { text, fingerprint: sha256(text), layerFingerprints: { agent: sha256(layers.agent), software: sha256(layers.software), project: sha256(layers.project), anchor: sha256(layers.anchor) } }; }
export function effectivePiPromptFingerprint(prompt: string, cwd: string): string { return sha256(`${prompt}\nCurrent working directory: ${cwd.replaceAll('\\', '/')}`); }
function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function escapeAttribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;'); }
