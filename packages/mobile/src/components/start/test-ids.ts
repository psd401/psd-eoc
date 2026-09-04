/**
 * Stable identifiers used only to drive the synthetic issue-21 Maestro flows.
 * Production screens opt into the fixture-specific IDs explicitly so ordinary
 * dynamic event cards never receive duplicate identifiers.
 */
export const ISSUE_21_MAESTRO_IDS = Object.freeze({
  activationResult: 'issue-21-activation-result',
  confirmDrill: 'issue-21-confirm-drill',
  drillEventType: 'issue-21-drill-event-type',
  drillThreat: 'issue-21-drill-threat',
  joinedResult: 'issue-21-joined-result',
  joinExisting: 'issue-21-join-existing',
  startDrill: 'issue-21-start-drill',
  syntheticMode: 'issue-21-synthetic-mode',
});
