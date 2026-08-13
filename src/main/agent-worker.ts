import { parentPort } from 'node:worker_threads';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  isAgentWorkerRequest,
  type AgentWorkerEvent,
} from '@shared/agent-protocol';
import { IRIS_PI_VERSION } from './agent/pi-adapter';

if (!parentPort) throw new Error('Iris Agent Worker requires a worker_threads parent port');
const workerPort = parentPort;

workerPort.on('message', (message: unknown) => {
  if (!isAgentWorkerRequest(message)) {
    workerPort.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'failure',
      correlation: { sessionId: 'unknown' },
      code: 'ProtocolMismatch',
      message: 'Unsupported Iris Agent Worker protocol message',
    } satisfies AgentWorkerEvent);
    return;
  }

  if (message.type === 'initialize') {
    workerPort.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'ready',
      correlation: message.correlation,
      runtime: {
        piVersion: IRIS_PI_VERSION,
        nodeVersion: process.versions.node,
        historyRevision: message.history.revision,
      },
    } satisfies AgentWorkerEvent);
    return;
  }

  if (message.type === 'shutdown') {
    workerPort.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'stopped',
      correlation: message.correlation,
      reason: 'shutdown',
    } satisfies AgentWorkerEvent);
    workerPort.close();
    return;
  }

  workerPort.postMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'failure',
    correlation: message.correlation,
    code: 'PhaseOneProtocolOnly',
    message: `${message.type} is defined but not connected to product persistence in phase one`,
  } satisfies AgentWorkerEvent);
});
