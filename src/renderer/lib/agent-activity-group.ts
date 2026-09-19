/**
 * The view model behind the activity group: which cards collapse into one
 * bounded list, and what each row of that list says.
 *
 * Kept as plain data (no JSX) so it can be unit tested — the four counters in
 * the summary are exactly the kind of thing that silently rots otherwise
 * (`files` used to be computed with a condition that could never be true).
 */
import type { IrisAgentCardState, IrisAgentCardView } from '@shared/types';

/**
 * The two card kinds a group absorbs. Both are "trivial operations": a label,
 * a tool, a state and one line of result are all the reader needs.
 */
export type TrivialCard = Extract<IrisAgentCardView, { kind: 'local-retrieval' | 'file-change' }>;

/** Everything else keeps its own card, frame and header. */
export type StandaloneCard = Exclude<IrisAgentCardView, TrivialCard>;

export type FileChangeCard = Extract<IrisAgentCardView, { kind: 'file-change' }>;
export type FileChangeAction = FileChangeCard['action'];
export type FileChangeTool = FileChangeCard['tool'];

export type AgentCardGroup =
  | { kind: 'activity-group'; cards: TrivialCard[] }
  | { kind: 'single'; card: StandaloneCard };

export function isTrivialCard(card: IrisAgentCardView): card is TrivialCard {
  return card.kind === 'local-retrieval' || card.kind === 'file-change';
}

/**
 * Only *consecutive* trivial cards become one group: a reply, a command card or
 * a background task card ends the run, so one intent can hold several groups.
 */
export function groupAgentCards(cards: IrisAgentCardView[]): AgentCardGroup[] {
  const groups: AgentCardGroup[] = [];
  for (const card of cards) {
    if (isTrivialCard(card)) {
      const previous = groups.at(-1);
      if (previous?.kind === 'activity-group') previous.cards.push(card);
      else groups.push({ kind: 'activity-group', cards: [card] });
    } else {
      groups.push({ kind: 'single', card });
    }
  }
  return groups;
}

/** The tool a row came from; the left icon follows it and nothing else. */
export type ActivityGroupTool = 'read' | 'terminal' | FileChangeTool;

type RowBase = {
  id: string;
  label: string;
  state: IrisAgentCardState | 'canceled';
  error: string | undefined;
  /** Set when the operation ran in a terminal, so the row can open its output. */
  terminalId: string | undefined;
};

export type ActivityGroupRow =
  | (RowBase & { family: 'read'; tool: 'read' })
  | (RowBase & { family: 'query'; tool: 'terminal' })
  | (RowBase & {
      family: 'file-change';
      tool: FileChangeTool;
      action: FileChangeAction;
      additions: number;
      deletions: number;
    });

/** One row per operation, in the order the Agent ran them. */
export function buildActivityRows(cards: TrivialCard[]): ActivityGroupRow[] {
  return cards.flatMap((card): ActivityGroupRow[] => {
    if (card.kind === 'file-change') {
      const stats = diffLineStats(card.diff);
      return [{
        id: card.id,
        label: card.path,
        state: card.state,
        error: card.error,
        terminalId: undefined,
        family: 'file-change',
        tool: card.tool,
        action: card.action,
        additions: stats.additions,
        deletions: stats.deletions,
      }];
    }
    return card.items.map((item): ActivityGroupRow => item.kind === 'file'
      ? {
          id: `${card.id}-${item.id}`,
          label: item.label,
          state: item.state,
          error: item.error,
          terminalId: item.terminalId,
          family: 'read',
          tool: 'read',
        }
      : {
          id: `${card.id}-${item.id}`,
          label: item.label,
          state: item.state,
          error: item.error,
          terminalId: item.terminalId,
          family: 'query',
          tool: 'terminal',
        });
  });
}

/**
 * The four counters above the list: one per tool plus the error count. Every
 * counter is measured per row, so a file change and a read count the same way.
 */
export function summarizeActivityRows(rows: ActivityGroupRow[]): string {
  const files = rows.filter((row) => row.family === 'read').length;
  const info = rows.filter((row) => row.family === 'query').length;
  const edits = rows.filter((row) => row.family === 'file-change').length;
  const failed = rows.filter((row) => row.state === 'failed').length;
  return `${files}读取 · ${info}信息 · ${edits}编辑 · ${failed}错误`;
}

export function fileActionLabel(action: FileChangeAction): string {
  if (action === 'created') return '创建';
  if (action === 'updated') return '修改';
  if (action === 'unchanged') return '未改变';
  return '写入失败';
}

export function diffLineStats(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}
