import type { GitResourceGroup } from '@shared/types';

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

const LABEL_MAP: Record<string, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '?': '未跟踪',
  '!': '已忽略',
  T: '类型变更',
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
  return LABEL_MAP[effectiveChar(status, group)] ?? status;
}
