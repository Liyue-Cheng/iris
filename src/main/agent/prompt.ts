import { createHash } from 'node:crypto';

export const IRIS_AGENT_PROMPT = `You are an expert coding assistant operating inside Iris Agent. You help users by reading files, executing visible terminal commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- terminal: Execute a visible command in the current project. Every call must declare intent as information (read-only inspection) or operation (may have side effects)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

Guidelines:
- Use terminal for project commands, searches, tests, and version-control inspection.
- For every terminal call, set intent to information only for read-only inspection such as git status, git diff, rg, or file listing. Use operation for tests, builds, installs, process control, Git writes, network writes, or whenever side effects are uncertain.
- Follow the shell dialect stated by the terminal tool; do not assume Bash syntax on Windows.
- Use read to examine files instead of shell-specific file-printing commands.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files

All file and terminal operations are hosted by Iris and constrained to the current project boundary.`;

export const IRIS_AGENT_PROMPT_METADATA = {
  upstreamPackage: '@earendil-works/pi-coding-agent',
  upstreamVersion: '0.84.1',
  upstreamPromptCwd: 'C:/iris-prompt-root',
  upstreamPromptSha256: 'bfd83ad660a7f76ee86a8beee63c80eda1441be7f717ae156dedaf0029c85293',
  adaptationVersion: 3,
  adaptation: [
    'rename Pi self-reference to Iris Agent',
    'rename bash to the visible Iris terminal tool',
    'replace Pi runtime guidance with the Iris project boundary',
    'remove custom-tool, PI_* environment, docs, extension, TUI, and skill guidance',
    'make terminal guidance shell-neutral so the runtime tool contract selects the dialect',
    'require every terminal call to declare information or operation intent',
  ],
  adaptedBasePromptSha256: sha256(IRIS_AGENT_PROMPT),
  finalPromptCwd: 'C:/iris-prompt-root',
  finalPromptSha256: effectivePiPromptFingerprint(IRIS_AGENT_PROMPT, 'C:/iris-prompt-root'),
} as const;

export interface CanonicalPromptSources {
  software: string;
  project: string;
  anchor: { path: string; text: string } | { workspacePath: string; text: string };
}

export interface CanonicalPromptAssembler {
  flush(): Promise<void>;
  readSources(): Promise<CanonicalPromptSources>;
}

export interface AssembledAgentPrompt {
  text: string;
  fingerprint: string;
  layerFingerprints: {
    agent: string;
    software: string;
    project: string;
    anchor: string;
  };
}

export async function assembleLatestAgentPrompt(
  source: CanonicalPromptAssembler,
): Promise<AssembledAgentPrompt> {
  await source.flush();
  return assembleAgentPrompt(await source.readSources());
}

export function assembleAgentPrompt(sources: CanonicalPromptSources): AssembledAgentPrompt {
  const anchorAttributes = 'path' in sources.anchor
    ? `kind="document" path="${escapeAttribute(sources.anchor.path)}"`
    : `kind="workspace" path="${escapeAttribute(sources.anchor.workspacePath)}"`;
  const layers = {
    agent: IRIS_AGENT_PROMPT,
    software: sources.software,
    project: sources.project,
    anchor: sources.anchor.text,
  };
  const text = [
    `<iris-agent-base version="${IRIS_AGENT_PROMPT_METADATA.adaptationVersion}">\n${layers.agent}\n</iris-agent-base>`,
    `<iris-software>\n${layers.software}\n</iris-software>`,
    `<iris-project>\n${layers.project}\n</iris-project>`,
    `<iris-anchor ${anchorAttributes}>\n${layers.anchor}\n</iris-anchor>`,
  ].join('\n\n');

  return {
    text,
    fingerprint: sha256(text),
    layerFingerprints: {
      agent: sha256(layers.agent),
      software: sha256(layers.software),
      project: sha256(layers.project),
      anchor: sha256(layers.anchor),
    },
  };
}

/** Pi 0.84.1 appends this fixed runtime layer even when a custom prompt is supplied. */
export function effectivePiPromptFingerprint(prompt: string, cwd: string): string {
  const normalizedCwd = cwd.replaceAll('\\', '/');
  return sha256(`${prompt}\nCurrent working directory: ${normalizedCwd}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
