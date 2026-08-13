export {
  activate,
  createPreview,
  join,
  loadStartHomeData,
  StartClientError,
  type StartAuthenticatedRequest,
  type StartHomeActiveEvent,
  type StartHomeData,
} from './start-api-client';
export {
  getBoundActivationPreview,
  type ActivationPreviewBinding,
} from './activation-preview-binding';
export {
  createIdempotentSubmission,
  IdempotentSubmissionController,
  type IdempotentSubmissionState,
} from './submission';
export {
  createIssue21SyntheticFixtureTransport,
  isIssue21SyntheticFixtureEnabled,
} from './issue-21-synthetic-fixture';
export { useStartMutationHardwareBackGuard } from './mutation-hardware-back-guard';
export {
  PENDING_START_MUTATION_MESSAGE,
  isStartMutationPending,
  requestStartRouteNavigation,
  subscribeToStartMutationHardwareBack,
  useStartMutationNavigationGuard,
} from './mutation-navigation-guard';
export {
  deliverClaimedStartMutationSuccessFeedback,
  StartMutationProvider,
  useStartMutation,
  type StartMutationContextValue,
  type StartMutationSuccessFeedbackSinks,
  type StartMutationProviderControllerDependencies,
  type SubmitStartActivationInput,
  type SubmitStartJoinInput,
} from './start-mutation-provider';
