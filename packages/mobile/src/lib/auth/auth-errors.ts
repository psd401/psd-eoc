export type AuthFailureKind =
  | 'configuration'
  | 'invalid-response'
  | 'offline'
  | 'rejected';

/** Bounded, credential-free error safe to render in the native client. */
export class MobileAuthError extends Error {
  public constructor(
    public readonly kind: AuthFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'MobileAuthError';
  }
}

/** Local safety boundary used by activation and every other mutation. */
export class OfflineMutationDeniedError extends Error {
  public constructor() {
    super(
      'Offline — starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again.',
    );
    this.name = 'OfflineMutationDeniedError';
  }
}
