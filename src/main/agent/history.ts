// Compatibility export for callers that previously imported the abandoned linear-history helper.
// Production and tests now share the same Turn-based domain reducer.
export {
  assertIrisAgentExpectedRevision,
  assertQuiescentIrisAgentSession,
  assertUndoableLatestIrisAgentTurn,
  isQuiescentIrisAgentSession,
  matchesActiveIrisAgentTurn,
  settleIrisAgentTurnDomain,
  undoLatestIrisAgentTurn,
} from './session-domain';
