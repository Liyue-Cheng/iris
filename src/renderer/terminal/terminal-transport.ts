import { CHANNELS, EVENTS } from '@shared/protocol';
import type {
  DocContent,
  IrisAgentTerminalOutputPayload,
  IrisAgentTerminalReplay,
  ProjectScope,
  SessionOutputPayload,
  SessionReplaySnapshot,
} from '@shared/types';
import { sameProjectScope } from '@renderer/stores/project-scope-state';
import { sendSessionInput, sendSessionResize } from '@renderer/lib/session-io';
import { textToBase64 } from './terminal-codec';

export interface TerminalTransport {
  readonly windowsBuild: number | null;
  onOutput(listener: (payload: SessionOutputPayload) => void): () => void;
  attach(): Promise<void>;
  detach(): Promise<void>;
  acknowledge(seq: number): Promise<void>;
  requestReplay(cols: number, rows: number): Promise<SessionReplaySnapshot>;
  sendInput(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  dispose(): void;
  readDocument(path: string): Promise<DocContent>;
  onWindowMaximized(listener: () => void): () => void;
}

export class ElectronTerminalTransport implements TerminalTransport {
  private readonly attachmentId: string;
  readonly windowsBuild = window.api.windowsBuild;

  constructor(
    private readonly sessionId: string,
    private readonly scope: ProjectScope,
    epoch = 0,
  ) {
    this.attachmentId = `${sessionId}:${epoch}`;
  }

  async attach(): Promise<void> {
    await window.api.invoke(CHANNELS.SESSION_OUTPUT_ATTACH, {
      sessionId: this.sessionId,
      attachmentId: this.attachmentId,
      expectedScope: this.scope,
    });
  }

  async detach(): Promise<void> {
    await window.api.invoke(CHANNELS.SESSION_OUTPUT_DETACH, {
      attachmentId: this.attachmentId,
    });
  }

  dispose(): void {}

  async acknowledge(seq: number): Promise<void> {
    await window.api.invoke(CHANNELS.SESSION_OUTPUT_ACK, {
      sessionId: this.sessionId,
      attachmentId: this.attachmentId,
      seq,
      expectedScope: this.scope,
    });
  }

  onOutput(listener: (payload: SessionOutputPayload) => void): () => void {
    return window.api.on<SessionOutputPayload>(EVENTS.SESSION_OUTPUT, (payload) => {
      if (payload.sessionId !== this.sessionId || !sameProjectScope(payload.scope, this.scope)) return;
      listener(payload);
    });
  }

  requestReplay(cols: number, rows: number): Promise<SessionReplaySnapshot> {
    return window.api.invoke<
      { sessionId: string; cols: number; rows: number; expectedScope: ProjectScope },
      SessionReplaySnapshot
    >(CHANNELS.SESSION_SCROLLBACK, {
      sessionId: this.sessionId,
      cols,
      rows,
      expectedScope: this.scope,
    });
  }

  async sendInput(text: string): Promise<void> {
    await sendSessionInput(this.sessionId, this.scope, textToBase64(text));
  }

  async resize(cols: number, rows: number): Promise<void> {
    await sendSessionResize(this.sessionId, this.scope, cols, rows);
  }

  readDocument(path: string): Promise<DocContent> {
    return window.api.invoke<{ path: string; expectedScope: ProjectScope }, DocContent>(
      CHANNELS.DOC_READ,
      { path, expectedScope: this.scope },
    );
  }

  onWindowMaximized(listener: () => void): () => void {
    return window.api.on<{ maximized: boolean }>(EVENTS.WINDOW_MAXIMIZED_CHANGED, listener);
  }
}

/** Agent-terminal transport adapted to the shared replay/runtime contract. */
export class IrisAgentTerminalTransport implements TerminalTransport {
  readonly windowsBuild = window.api.windowsBuild;
  /** One dialog mount per attachment, so a stale unmount cannot detach a newer view. */
  private readonly attachmentId = crypto.randomUUID();

  constructor(
    private readonly sessionId: string,
    private readonly terminalId: string,
    private readonly scope: ProjectScope,
  ) {}

  /**
   * Binds main's per-terminal output delivery. Until this succeeds the command's
   * output only reaches the mirror and the log file, which is why closing a
   * dialog costs nothing and reopening replays the whole thing.
   */
  async attach(): Promise<void> {
    await window.api.invoke(CHANNELS.IRIS_AGENT_TERMINAL_ATTACH, this.attachment());
  }

  async detach(): Promise<void> {
    await window.api.invoke(CHANNELS.IRIS_AGENT_TERMINAL_DETACH, this.attachment());
  }

  dispose(): void {}

  /** Releases main's in-flight budget so a paused PTY can resume. */
  async acknowledge(seq: number): Promise<void> {
    await window.api.invoke(CHANNELS.IRIS_AGENT_TERMINAL_ACK, { ...this.attachment(), seq });
  }

  private attachment(): {
    sessionId: string;
    terminalId: string;
    attachmentId: string;
    expectedScope: ProjectScope;
  } {
    return {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
      attachmentId: this.attachmentId,
      expectedScope: this.scope,
    };
  }

  onOutput(listener: (payload: SessionOutputPayload) => void): () => void {
    return window.api.on<IrisAgentTerminalOutputPayload>(EVENTS.IRIS_AGENT_TERMINAL_OUTPUT, (payload) => {
      if (payload.sessionId !== this.sessionId || payload.terminalId !== this.terminalId) return;
      listener({ scope: this.scope, sessionId: this.sessionId, data: payload.data, seq: payload.seq });
    });
  }

  async requestReplay(cols: number, rows: number): Promise<SessionReplaySnapshot> {
    const replay = await window.api.invoke<{
      sessionId: string; terminalId: string; cols: number; rows: number; expectedScope: ProjectScope;
    }, IrisAgentTerminalReplay>(CHANNELS.IRIS_AGENT_TERMINAL_REPLAY, {
      sessionId: this.sessionId, terminalId: this.terminalId, cols, rows, expectedScope: this.scope,
    });
    return { data: replay.data, lastSeq: replay.seq, cols, rows };
  }

  sendInput(data: string): Promise<void> {
    return window.api.invoke(CHANNELS.IRIS_AGENT_TERMINAL_INPUT, {
      sessionId: this.sessionId, terminalId: this.terminalId, data, expectedScope: this.scope,
    });
  }

  resize(cols: number, rows: number): Promise<void> {
    return window.api.invoke(CHANNELS.IRIS_AGENT_TERMINAL_RESIZE, {
      sessionId: this.sessionId, terminalId: this.terminalId, cols, rows, expectedScope: this.scope,
    });
  }

  readDocument(path: string): Promise<DocContent> {
    return window.api.invoke<{ path: string; expectedScope: ProjectScope }, DocContent>(CHANNELS.DOC_READ, {
      path, expectedScope: this.scope,
    });
  }

  onWindowMaximized(_listener: () => void): () => void { return () => undefined; }
}

export function getTerminalDroppedFilePath(file: File): string {
  return window.api.getPathForFile(file);
}
