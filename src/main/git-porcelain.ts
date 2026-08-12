import type { GitResource, GitSnapshot } from '@shared/types';

export interface ParsedGitStatus {
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  groups: GitSnapshot['groups'];
}

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function emptyGroups(): GitSnapshot['groups'] {
  return { merge: [], index: [], workingTree: [], untracked: [] };
}

function parseBranchHeader(
  header: string,
): Pick<ParsedGitStatus, 'branch' | 'detached' | 'ahead' | 'behind'> {
  const value = header.slice(3);
  const tracking = value.match(/\[(?:(?:ahead (\d+))?(?:, )?(?:behind (\d+))?|gone)\]$/);
  const ahead = Number(tracking?.[1] ?? 0);
  const behind = Number(tracking?.[2] ?? 0);
  const withoutTracking = tracking ? value.slice(0, tracking.index).trimEnd() : value;
  const name = withoutTracking.split('...')[0]!.trim();

  if (name === 'HEAD (no branch)' || name.startsWith('HEAD detached ')) {
    return { branch: null, detached: true, ahead, behind };
  }
  const unborn = name.match(/^(?:No commits yet|Initial commit) on (.+)$/);
  return { branch: unborn?.[1] ?? name, detached: false, ahead, behind };
}

function addResource(
  groups: GitSnapshot['groups'],
  status: string,
  path: string,
  originalPath?: string,
): void {
  const resource = (group: GitResource['group']): GitResource => ({
    path,
    status,
    group,
    ...(originalPath !== undefined ? { originalPath } : {}),
  });

  if (status === '??') {
    groups.untracked.push(resource('untracked'));
    return;
  }
  if (status === '!!') return;
  if (CONFLICT_STATUSES.has(status) || status.includes('U')) {
    groups.merge.push(resource('merge'));
    return;
  }
  if (status[0] !== ' ') groups.index.push(resource('index'));
  if (status[1] !== ' ') groups.workingTree.push(resource('workingTree'));
}

/** Parse `git status --porcelain=v1 -z --branch` without decoding path syntax. */
export function parseGitPorcelainV1Z(output: string): ParsedGitStatus {
  const parts = output.split('\0');
  const groups = emptyGroups();
  let branch: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.startsWith('## ')) {
      ({ branch, detached, ahead, behind } = parseBranchHeader(part));
      continue;
    }
    if (part.length < 4 || part[2] !== ' ') continue;
    const status = part.slice(0, 2);
    const path = part.slice(3);
    const hasSecondPath = status.includes('R') || status.includes('C');
    const originalPath = hasSecondPath ? parts[index + 1] : undefined;
    if (hasSecondPath && originalPath !== undefined) index += 1;
    addResource(groups, status, path, originalPath || undefined);
  }

  return { branch, detached, ahead, behind, groups };
}
