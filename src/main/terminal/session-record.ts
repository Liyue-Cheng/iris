import type { IDisposable, IPty } from 'node-pty';
import type { SessionInfo } from '@shared/types';
import type { SessionActivityController } from './session-activity';
import type { TerminalOutputPump } from './output-pump';
import type { TerminalMirror } from './terminal-mirror';
import type { TerminalProtocol } from './terminal-protocol';
import type { TerminalFlowController } from './flow-controller';
import type { TerminalFlightRecorder } from './flight-recorder';
import type { TerminalProcessState } from '@shared/terminal/process-reducer';

export interface SessionRecord {
  info: SessionInfo;
  pty: IPty | null;
  disposables: IDisposable[];
  output: TerminalOutputPump;
  activity: SessionActivityController;
  mirror: TerminalMirror;
  protocol: TerminalProtocol;
  flow: TerminalFlowController;
  outputAttachmentId: string | null;
  recorder: TerminalFlightRecorder;
  processState: TerminalProcessState;
  closePromise: Promise<void> | null;
}
