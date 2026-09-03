import type { IrisAgentSessionInfo, TerminalSessionInfo } from '@shared/types';
import type { SessionProjection } from '@renderer/lib/session-projection';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { IrisAgentView } from '@renderer/components/agent/IrisAgentView';

type ProjectedSessionViewProps = {
  projection: SessionProjection;
  terminalSession: TerminalSessionInfo | null;
  agentSession: IrisAgentSessionInfo | null;
  onForked: (session: IrisAgentSessionInfo) => void;
};

type RendererProps = Omit<ProjectedSessionViewProps, 'projection'>;
type SessionRenderer = (props: RendererProps & { projection: SessionProjection }) => JSX.Element | null;

const sessionRenderers: Record<SessionProjection['kind'], SessionRenderer> = {
  terminal: ({ projection, terminalSession }) => terminalSession
    ? <TerminalView key={projection.id} sessionId={terminalSession.id} />
    : null,
  'iris-agent': ({ projection, agentSession, onForked }) => agentSession
    ? <IrisAgentView key={projection.id} session={agentSession} onForked={onForked} />
    : null,
};

/** Selects a domain renderer from the unified read model. */
export function ProjectedSessionView(props: ProjectedSessionViewProps): JSX.Element | null {
  const Renderer = sessionRenderers[props.projection.kind];
  return <Renderer {...props} />;
}
