import type { GitResourceGroup } from '@shared/types';
import { translate } from '@renderer/i18n';

const COLOR_MAP: Record<string, string> = {
  M: 'var(--rp-gold)',
  A: 'var(--rp-foam)',
  D: 'var(--rp-love)',
  R: 'var(--rp-iris)',
  C: 'var(--rp-iris)',
  U: 'var(--rp-love)',
  '?': 'var(--rp-muted)',
  '!': 'var(--rp-muted)',
  T: 'var(--rp-gold)',
};

const LABEL_MAP: Record<string, 'git.modified' | 'git.added' | 'git.deleted' | 'git.renamed' | 'git.copied' | 'git.conflict' | 'git.untracked' | 'git.ignored' | 'git.typeChanged'> = {
  M: 'git.modified',
  A: 'git.added',
  D: 'git.deleted',
  R: 'git.renamed',
  C: 'git.copied',
  U: 'git.conflict',
  '?': 'git.untracked',
  '!': 'git.ignored',
  T: 'git.typeChanged',
};

export function effectiveChar(status: string, group: GitResourceGroup): string {
  if (group === 'untracked') return '?';
  if (group === 'merge') return 'U';
  if (group === 'index') return status[0] === ' ' ? status[1]! : status[0]!;
  return status[1] === ' ' ? status[0]! : status[1]!;
}

export function statusColor(status: string, group: GitResourceGroup): string {
  return COLOR_MAP[effectiveChar(status, group)] ?? 'var(--rp-muted)';
}

export function statusLabel(status: string, group: GitResourceGroup): string {
  const key = LABEL_MAP[effectiveChar(status, group)];
  return key ? translate(key) : status;
}
