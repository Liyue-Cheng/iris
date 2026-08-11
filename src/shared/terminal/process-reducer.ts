export type TerminalProcessState =
  | 'spawning'
  | 'running'
  | 'exited'
  | 'closing'
  | 'disposed'
  | 'failed';

export type TerminalProcessEvent =
  | { type: 'SPAWNED' }
  | { type: 'SPAWN_FAILED' }
  | { type: 'EXITED' }
  | { type: 'CLOSE' }
  | { type: 'DISPOSE' };

export function reduceTerminalProcess(
  state: TerminalProcessState,
  event: TerminalProcessEvent,
): TerminalProcessState {
  switch (state) {
    case 'spawning':
      if (event.type === 'SPAWNED') return 'running';
      if (event.type === 'SPAWN_FAILED') return 'failed';
      break;
    case 'running':
      if (event.type === 'EXITED') return 'exited';
      if (event.type === 'CLOSE') return 'closing';
      break;
    case 'closing':
      if (event.type === 'EXITED') return 'exited';
      if (event.type === 'DISPOSE') return 'disposed';
      break;
    case 'exited':
      if (event.type === 'CLOSE') return 'closing';
      if (event.type === 'DISPOSE') return 'disposed';
      break;
    case 'failed':
      if (event.type === 'DISPOSE') return 'disposed';
      break;
    case 'disposed':
      break;
  }
  return state;
}
