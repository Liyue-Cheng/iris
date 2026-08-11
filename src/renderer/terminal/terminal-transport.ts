import { CHANNELS, EVENTS } from '@shared/protocol';
import type {
  DocContent,
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

export function getTerminalDroppedFilePath(file: File): string {
  return window.api.getPathForFile(file);
}
