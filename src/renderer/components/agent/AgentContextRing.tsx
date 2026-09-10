import {
  CONTEXT_RING_CIRCUMFERENCE,
  CONTEXT_RING_RADIUS,
  CONTEXT_RING_SIZE,
  CONTEXT_RING_STROKE,
  contextRingOffset,
  contextTriggerAngle,
} from '@renderer/lib/agent-context-usage';
import type { IrisAgentContextBudget, IrisAgentContextUsage } from '@shared/types';

/**
 * The context window as one static ring. It never animates on its own so it
 * cannot be mistaken for the activity ring on the Agent avatar; only a change
 * in the reading moves the arc. Geometry comes from the pure presentation
 * module, which is also where the strict percentage is computed, and colour is
 * inherited from the surrounding indicator.
 */
export function AgentContextRing({
  usage,
  budget,
}: {
  usage: IrisAgentContextUsage | null;
  budget: IrisAgentContextBudget;
}): JSX.Element {
  const center = CONTEXT_RING_SIZE / 2;
  const triggerAngle = contextTriggerAngle(budget);
  return (
    <svg
      className="iris-agent-context-ring"
      width={CONTEXT_RING_SIZE}
      height={CONTEXT_RING_SIZE}
      viewBox={`0 0 ${CONTEXT_RING_SIZE} ${CONTEXT_RING_SIZE}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="iris-agent-context-ring-track"
        cx={center}
        cy={center}
        r={CONTEXT_RING_RADIUS}
        strokeWidth={CONTEXT_RING_STROKE}
        fill="none"
      />
      {usage && (
        <circle
          className="iris-agent-context-ring-fill"
          cx={center}
          cy={center}
          r={CONTEXT_RING_RADIUS}
          strokeWidth={CONTEXT_RING_STROKE}
          fill="none"
          strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
          strokeDashoffset={contextRingOffset(usage, budget)}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
      {triggerAngle < 360 && (
        <line
          className="iris-agent-context-ring-trigger"
          x1={center}
          y1={center - CONTEXT_RING_RADIUS - CONTEXT_RING_STROKE / 2}
          x2={center}
          y2={center - CONTEXT_RING_RADIUS + CONTEXT_RING_STROKE / 2}
          transform={`rotate(${triggerAngle} ${center} ${center})`}
        />
      )}
    </svg>
  );
}
