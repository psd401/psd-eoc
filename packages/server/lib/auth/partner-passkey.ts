import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CognitoIdentityProviderClient,
  CompleteWebAuthnRegistrationCommand,
  StartWebAuthnRegistrationCommand,
  type CompleteWebAuthnRegistrationCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  PartnerPasskeyClientDataSchema,
  PartnerPasskeyCreationOptionsSchema,
  PartnerPasskeyRequestOptionsSchema,
  PasskeyRelyingPartyIdSchema,
  type PartnerPasskeyAssertionCredential,
  type PartnerPasskeyClientData,
  type PartnerPasskeyCreationOptions,
  type PartnerPasskeyRegistrationCredential,
  type PartnerPasskeyRequestOptions,
} from '@psd-eoc/contracts';

import { applicationOriginForRequest } from './application-origin';
import {
  readPartnerPoolConfiguration,
  type Environment,
  type PartnerPoolConfiguration,
} from './identity-providers';
import {
  createPartnerClientSecretReader,
  PartnerOtpError,
  partnerSecretHash,
  refusePartnerSignIn,
  syntheticPartnerAccessToken,
  syntheticPartnerSubject,
  type PartnerFactorVerification,
  type PartnerOtpChallenge,
} from './partner-otp';
import { verifyPartnerIdToken } from './partner-otp';

/**
 * Partner passkey sign-in and enrollment, at the dependency boundary.
 *
 * A passkey is the second first-factor the partner pool allows, beside the
 * emailed code (`partner-otp.ts`). It is optional and it is never a different
 * grant: the pool proves the factor, and the admission still decides access,
 * so a partner with a passkey and a partner with a code reach exactly the
 * same session through exactly the same authorizer.
 *
 * This is also the one place a browser takes part in partner sign-in. Nothing
 * here lets the page talk to Amazon: the page runs the WebAuthn ceremony,
 * which only it can, and posts the result to this deployment, which forwards
 * it to the pool with the confidential client's credential. There is still no
 * redirect, no hosted UI, and no provider callback.
 *
 * Issue #599.
 */

/** Cognito's documented challenge-parameter key for a passkey request. */
const CREDENTIAL_REQUEST_OPTIONS = 'CREDENTIAL_REQUEST_OPTIONS';
const MAX_PROVIDER_DOCUMENT_BYTES = 16 * 1_024;
const SYNTHETIC_PASSKEY_FLOW_PREFIX = 'synthetic-partner-passkey:';

/**
 * The relying-party id partner passkeys are bound to.
 *
 * It is the application's own hostname, derived from the deployment's
 * application origin (`psdEoc:applicationOrigin`, which reaches the runtime
 * as `GOOGLE_OIDC_APPLICATION_ORIGIN`) rather than configured a second time
 * beside it. Deriving it is what keeps the pool's `web_authn_configuration`,
 * the page the ceremony runs on, and the mobile association files naming one
 * hostname: a passkey is bound to this value, so two configured copies that
 * drifted apart would invalidate every enrolled passkey with no error
 * anywhere.
 *
 * A hostname with a port, a scheme, a path, or an IP address literal cannot
 * be a relying-party id, so such an origin is a configuration error here
 * rather than a ceremony that silently never completes.
 */
export function partnerRelyingPartyIdFromOrigin(origin: string): string {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    throw new PartnerOtpError(
      'PARTNER_SIGN_IN_UNCONFIGURED',
      'The application origin is not a URL, so no relying-party id exists.',
    );
  }
  const parsed = PasskeyRelyingPartyIdSchema.safeParse(hostname);
  if (!parsed.success) {
    throw new PartnerOtpError(
      'PARTNER_SIGN_IN_UNCONFIGURED',
      'The application origin has no hostname usable as a relying-party id.',
    );
  }
  return parsed.data;
}

/**
 * The relying-party id for the request being served.
 *
 * In production this is the configured application origin, which is the only
 * origin the deployment answers on. Outside production it is the request's
 * own origin, so a developer or a browser flow on `localhost` enrolls a
 * passkey against `localhost` — the same rule
 * `applicationOriginForRequest` already applies to every redirect, so the
 * ceremony can never be bound to a host the page is not served from.
 */
export function partnerRelyingPartyIdForRequest(
  requestUrl: string | URL,
  environment: Environment = process.env,
): string {
  return partnerRelyingPartyIdFromOrigin(
    applicationOriginForRequest(requestUrl, environment),
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads the client data the authenticator signed over.
 *
 * This is the one part of a WebAuthn response the server reads for itself.
 * Everything else is opaque bytes only the pool can check, but client data
 * states which ceremony was performed and which origin asked for it, and both
 * must match what this deployment asked for. Returns null for anything that
 * is not the expected ceremony on this origin, and the caller then refuses.
 */
export function readPasskeyClientData(
  clientDataJSON: string,
  expected: Readonly<{
    type: 'webauthn.create' | 'webauthn.get';
    origin: string;
  }>,
): PartnerPasskeyClientData | null {
  let decoded: string;
  try {
    const bytes = Buffer.from(clientDataJSON, 'base64url');
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1_024) {
      return null;
    }
    decoded = bytes.toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  const clientData = PartnerPasskeyClientDataSchema.safeParse(parsed);
  if (!clientData.success) {
    return null;
  }
  const value = clientData.data;
  // A ceremony performed inside a frame on another site is refused: the
  // partner must be looking at this deployment's own page.
  if (
    value.type !== expected.type ||
    value.crossOrigin === true ||
    (value.topOrigin !== undefined && value.topOrigin !== expected.origin) ||
    !constantTimeEqual(value.origin, expected.origin)
  ) {
    return null;
  }
  return value;
}

/** What the pool answers when a passkey sign-in may proceed. */
export interface PartnerPasskeyChallenge extends PartnerOtpChallenge {
  readonly options: PartnerPasskeyRequestOptions;
}

export interface PartnerPasskeyProvider {
  readonly issuer: string;
  readonly audience: string;
  /**
   * Asks the pool for a passkey challenge for one address.
   *
   * Null means this address signs in with a code instead. It is the answer
   * for an address with no passkey, an address the pool does not hold at all,
   * and a pool that offered some other challenge — deliberately one answer,
   * because any difference would let the form be used to ask who is enrolled.
   */
  startSignIn(
    email: string,
    relyingPartyId: string,
  ): Promise<PartnerPasskeyChallenge | null>;
  /** Answers one passkey challenge and returns the pool's verified identity. */
  verifySignIn(
    input: Readonly<{
      email: string;
      flowSession: string;
      credential: PartnerPasskeyAssertionCredential;
    }>,
  ): Promise<PartnerFactorVerification>;
  /** Begins enrolling a passkey for the partner that token belongs to. */
  startRegistration(
    input: Readonly<{
      email: string;
      accessToken: string;
      relyingPartyId: string;
    }>,
  ): Promise<PartnerPasskeyCreationOptions>;
  /** Hands the pool a newly created passkey. */
  completeRegistration(
    input: Readonly<{
      email: string;
      accessToken: string;
      credential: PartnerPasskeyRegistrationCredential;
    }>,
  ): Promise<void>;
}

/**
 * Re-states a provider document as the options a page may be handed.
 *
 * The pool composes the ceremony options, and this deployment never passes
 * them through unread: the relying party must be the one derived from this
 * deployment's own origin, and user verification must be required. A pool
 * whose WebAuthn configuration has drifted from the application's hostname is
 * a configuration error, not a ceremony to hand a partner.
 */
function requestOptionsFor(
  document: unknown,
  relyingPartyId: string,
): PartnerPasskeyRequestOptions {
  const parsed = PartnerPasskeyRequestOptionsSchema.safeParse(document);
  if (!parsed.success || parsed.data.rpId !== relyingPartyId) {
    throw new PartnerOtpError(
      'PARTNER_PROVIDER_UNAVAILABLE',
      'The partner pool offered passkey options for another relying party.',
    );
  }
  return parsed.data;
}

function creationOptionsFor(
  document: unknown,
  relyingPartyId: string,
): PartnerPasskeyCreationOptions {
  const parsed = PartnerPasskeyCreationOptionsSchema.safeParse(document);
  if (!parsed.success || parsed.data.rp.id !== relyingPartyId) {
    throw new PartnerOtpError(
      'PARTNER_PROVIDER_UNAVAILABLE',
      'The partner pool offered a passkey for another relying party.',
    );
  }
  return parsed.data;
}

/**
 * Re-states a validated credential as the plain JSON document the SDK takes.
 *
 * Cognito's `Credential` field is an untyped JSON document, and the frozen,
 * optional-bearing object the schema produces is not one: a key whose value
 * is `undefined` cannot be serialized. Round-tripping through JSON drops
 * exactly those keys and nothing else, which is also precisely what the
 * credential looks like on the wire from the browser.
 */
function providerCredentialDocument(
  credential: PartnerPasskeyRegistrationCredential,
): CompleteWebAuthnRegistrationCommandInput['Credential'] {
  return JSON.parse(
    JSON.stringify(credential),
  ) as CompleteWebAuthnRegistrationCommandInput['Credential'];
}

/** Refuses a provider document too large to be a ceremony. */
function boundedDocument(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_DOCUMENT_BYTES
  ) {
    throw new PartnerOtpError(
      'PARTNER_PROVIDER_UNAVAILABLE',
      'The partner pool answered with an unusable passkey document.',
    );
  }
  return value;
}

/** Cognito, at the dependency boundary. SDK retries stay off; a retry is ours. */
export class CognitoPartnerPasskeyProvider implements PartnerPasskeyProvider {
  public readonly issuer: string;
  public readonly audience: string;
  private readonly readClientSecret: () => Promise<string>;

  public constructor(
    private readonly configuration: PartnerPoolConfiguration,
    private readonly client: Pick<
      CognitoIdentityProviderClient,
      'send'
    > = new CognitoIdentityProviderClient({ maxAttempts: 1 }),
    readClientSecret?: () => Promise<string>,
  ) {
    if (configuration.clientSecretArn === null) {
      throw new PartnerOtpError(
        'PARTNER_SIGN_IN_UNCONFIGURED',
        'The partner app client has no credential ARN.',
      );
    }
    this.issuer = configuration.issuer;
    this.audience = configuration.clientId;
    this.readClientSecret =
      readClientSecret ??
      createPartnerClientSecretReader(configuration.clientSecretArn);
  }

  public async startSignIn(
    email: string,
    relyingPartyId: string,
  ): Promise<PartnerPasskeyChallenge | null> {
    const clientSecret = await this.readClientSecret();
    let session: string | undefined;
    let challenge: string | undefined;
    let parameters: Readonly<Record<string, string>> | undefined;
    try {
      const response = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.configuration.userPoolId,
          ClientId: this.configuration.clientId,
          AuthFlow: 'USER_AUTH',
          AuthParameters: {
            USERNAME: email,
            PREFERRED_CHALLENGE: 'WEB_AUTHN',
            SECRET_HASH: partnerSecretHash(
              clientSecret,
              email,
              this.configuration.clientId,
            ),
          },
        }),
      );
      session = response.Session;
      challenge = response.ChallengeName;
      parameters = response.ChallengeParameters;
    } catch (error) {
      // An address the pool does not hold answers exactly as one that holds
      // no passkey: sign in with a code. The pool's app client hides user
      // existence, so this branch is normally a provider problem, and a
      // provider problem must still not stop the code path from working.
      if (error instanceof Error && error.name === 'UserNotFoundException') {
        return null;
      }
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner identity provider did not answer.',
      );
    }
    // The pool answers the preferred challenge when it can and some other
    // challenge when it cannot — a partner with no passkey yet gets the code
    // challenge here. Either way the answer is the same: use a code.
    if (challenge !== 'WEB_AUTHN' || session === undefined) {
      return null;
    }
    const document = parameters?.[CREDENTIAL_REQUEST_OPTIONS];
    if (document === undefined) {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner pool offered a passkey challenge with no options.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(boundedDocument(document))) as unknown;
    } catch {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner pool answered with an unusable passkey document.',
      );
    }
    return Object.freeze({
      flowSession: session,
      options: requestOptionsFor(parsed, relyingPartyId),
    });
  }

  public async verifySignIn(
    input: Readonly<{
      email: string;
      flowSession: string;
      credential: PartnerPasskeyAssertionCredential;
    }>,
  ): Promise<PartnerFactorVerification> {
    const clientSecret = await this.readClientSecret();
    let idToken: string | undefined;
    let accessToken: string | undefined;
    try {
      const response = await this.client.send(
        new AdminRespondToAuthChallengeCommand({
          UserPoolId: this.configuration.userPoolId,
          ClientId: this.configuration.clientId,
          ChallengeName: 'WEB_AUTHN',
          Session: input.flowSession,
          ChallengeResponses: {
            USERNAME: input.email,
            // Cognito takes the W3C `AuthenticationResponseJSON` document.
            CREDENTIAL: JSON.stringify(input.credential),
            SECRET_HASH: partnerSecretHash(
              clientSecret,
              input.email,
              this.configuration.clientId,
            ),
          },
        }),
      );
      idToken = response.AuthenticationResult?.IdToken;
      accessToken = response.AuthenticationResult?.AccessToken;
    } catch {
      // A rejected assertion, an expired challenge, and a disabled account —
      // which is how a partner's access ending makes their passkey stop
      // working — all land here and are all one refusal.
      refusePartnerSignIn();
    }
    if (idToken === undefined) {
      refusePartnerSignIn();
    }
    const claims = await verifyPartnerIdToken(this.configuration, idToken);
    if (claims.email !== input.email) {
      refusePartnerSignIn();
    }
    return Object.freeze({ claims, accessToken: accessToken ?? null });
  }

  public async startRegistration(
    input: Readonly<{
      email: string;
      accessToken: string;
      relyingPartyId: string;
    }>,
  ): Promise<PartnerPasskeyCreationOptions> {
    let document: unknown;
    try {
      const response = await this.client.send(
        new StartWebAuthnRegistrationCommand({
          AccessToken: input.accessToken,
        }),
      );
      document = response.CredentialCreationOptions;
    } catch {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner pool would not begin a passkey enrollment.',
      );
    }
    return creationOptionsFor(boundedDocument(document), input.relyingPartyId);
  }

  public async completeRegistration(
    input: Readonly<{
      email: string;
      accessToken: string;
      credential: PartnerPasskeyRegistrationCredential;
    }>,
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteWebAuthnRegistrationCommand({
          AccessToken: input.accessToken,
          Credential: providerCredentialDocument(input.credential),
        }),
      );
    } catch {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner pool would not complete the passkey enrollment.',
      );
    }
  }
}

/**
 * What the stand-in remembers between the steps of a ceremony.
 *
 * Process-local, like the one-time-password limiter beside it, and for the
 * same reason: it exists only for the browser flows and local development,
 * where one server process serves the whole run. A deployed configuration
 * cannot reach the stand-in at all (`readPartnerPoolConfiguration` requires
 * the test-only variable and a loopback database), so there is no deployment
 * in which this map being per-process matters.
 */
interface SyntheticPasskeyState {
  /** Registered credential ids, by lower-cased address. */
  readonly credentials: Map<string, Set<string>>;
  /** The challenge issued for one open sign-in session. */
  readonly sessions: Map<
    string,
    Readonly<{ email: string; challenge: string }>
  >;
  /** The challenge issued for one open registration, by address. */
  readonly registrations: Map<string, string>;
}

/**
 * Held on `globalThis`, not in this module's scope.
 *
 * The development server re-evaluates a route's modules between requests, so
 * module-scope state does not survive from one request of a ceremony to the
 * next: a passkey enrolled by one request would be unknown to the sign-in
 * that followed it, and the stand-in would silently answer "use a code"
 * forever. Nothing in a deployment reaches the stand-in at all, so this is
 * only about keeping local development and the browser flows honest.
 */
const SYNTHETIC_PASSKEY_STATE = Symbol.for(
  'psd-eoc.synthetic-partner-passkeys',
);

function syntheticState(): SyntheticPasskeyState {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const existing = holder[SYNTHETIC_PASSKEY_STATE] as
    SyntheticPasskeyState | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const created: SyntheticPasskeyState = {
    credentials: new Map(),
    sessions: new Map(),
    registrations: new Map(),
  };
  holder[SYNTHETIC_PASSKEY_STATE] = created;
  return created;
}

/** Forgets every stand-in passkey. For tests that need a clean pool. */
export function resetSyntheticPartnerPasskeys(): void {
  syntheticState().credentials.clear();
  syntheticState().sessions.clear();
  syntheticState().registrations.clear();
}

/**
 * Forgets one address's stand-in passkeys.
 *
 * The stand-in for the directory calls this when a partner is disabled,
 * because that is what the real pool does: `AdminDisableUser` makes every
 * credential the account holds unusable, passkeys included. Without this the
 * stand-in would let a disabled partner's passkey keep proving a first factor
 * — the admission would still refuse the sign-in, but the browser flows could
 * not show the pool layer refusing it too.
 */
export function forgetSyntheticPartnerPasskeys(email: string): void {
  const address = email.trim().toLowerCase();
  syntheticState().credentials.delete(address);
  syntheticState().registrations.delete(address);
  for (const [session, open] of syntheticState().sessions) {
    if (open.email === address) {
      syntheticState().sessions.delete(session);
    }
  }
}

/** True when the stand-in holds a passkey for the address. */
export function syntheticPartnerHasPasskey(email: string): boolean {
  return (
    (syntheticState().credentials.get(email.trim().toLowerCase())?.size ?? 0) >
    0
  );
}

function syntheticChallenge(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stand-in for browser tests and local development: no pool is contacted
 * and no authenticator is trusted.
 *
 * It checks everything about a ceremony that does not need the pool's copy of
 * the credential: the ceremony type, the origin, the challenge it issued, and
 * that the credential id is one it registered for this address. It does not
 * verify the authenticator's signature, because verifying a signature is
 * precisely what the real pool is for and a stand-in that did it would be a
 * second WebAuthn implementation to keep correct. A browser flow against this
 * stand-in therefore proves the plumbing, the origin and challenge binding,
 * and the pages — not Amazon's cryptography.
 */
export function syntheticPartnerPasskeyProvider(
  configuration: PartnerPoolConfiguration,
): PartnerPasskeyProvider {
  return Object.freeze({
    issuer: configuration.issuer,
    audience: configuration.clientId,
    startSignIn: (email: string, relyingPartyId: string) => {
      const address = email.trim().toLowerCase();
      const registered = syntheticState().credentials.get(address);
      if (registered === undefined || registered.size === 0) {
        return Promise.resolve(null);
      }
      const challenge = syntheticChallenge();
      const flowSession = `${SYNTHETIC_PASSKEY_FLOW_PREFIX}${randomBytes(
        24,
      ).toString('base64url')}`;
      syntheticState().sessions.set(
        flowSession,
        Object.freeze({ email: address, challenge }),
      );
      return Promise.resolve(
        Object.freeze({
          flowSession,
          options: PartnerPasskeyRequestOptionsSchema.parse({
            rpId: relyingPartyId,
            challenge,
            userVerification: 'required',
            allowCredentials: [...registered].map((id) => ({
              type: 'public-key' as const,
              id,
            })),
          }),
        }),
      );
    },
    verifySignIn: async (
      input: Readonly<{
        email: string;
        flowSession: string;
        credential: PartnerPasskeyAssertionCredential;
      }>,
    ) => {
      const open = syntheticState().sessions.get(input.flowSession);
      // One challenge, one answer: the session is spent whether or not the
      // assertion is accepted, so a rejected credential cannot be retried
      // against the same challenge.
      syntheticState().sessions.delete(input.flowSession);
      const address = input.email.trim().toLowerCase();
      const registered = syntheticState().credentials.get(address);
      if (
        open === undefined ||
        open.email !== address ||
        registered === undefined ||
        !registered.has(input.credential.id)
      ) {
        refusePartnerSignIn();
      }
      const clientData = readSyntheticClientData(
        input.credential.response.clientDataJSON,
      );
      if (
        clientData === null ||
        clientData.type !== 'webauthn.get' ||
        !constantTimeEqual(clientData.challenge, open.challenge)
      ) {
        refusePartnerSignIn();
      }
      return Object.freeze({
        claims: Object.freeze({
          issuer: configuration.issuer,
          audience: configuration.clientId,
          subject: syntheticPartnerSubject(address),
          email: address,
          // A fresh digest per sign-in, so two passkey sign-ins by the same
          // partner are two exchanges rather than a replay of one. The real
          // pool's digest is of a freshly signed identity token, which is
          // already distinct per sign-in.
          claimsDigest: sha256Hex(
            `${SYNTHETIC_PASSKEY_FLOW_PREFIX}${address}\n${open.challenge}`,
          ),
        }),
        accessToken: syntheticPartnerAccessToken(address),
      });
    },
    startRegistration: (
      input: Readonly<{
        email: string;
        accessToken: string;
        relyingPartyId: string;
      }>,
    ) => {
      const address = input.email.trim().toLowerCase();
      if (
        !constantTimeEqual(
          input.accessToken,
          syntheticPartnerAccessToken(address),
        )
      ) {
        // The hand-off does not belong to this address. The real pool decides
        // this by reading its own token; the stand-in derives it instead.
        return Promise.reject(
          new PartnerOtpError(
            'PARTNER_SIGN_IN_REFUSED',
            'The partner sign-in details were not accepted.',
          ),
        );
      }
      const challenge = syntheticChallenge();
      syntheticState().registrations.set(address, challenge);
      return Promise.resolve(
        PartnerPasskeyCreationOptionsSchema.parse({
          rp: { id: input.relyingPartyId, name: 'PSD EOC' },
          user: {
            id: Buffer.from(syntheticPartnerSubject(address), 'utf8').toString(
              'base64url',
            ),
            name: address,
            displayName: address,
          },
          challenge,
          // ES256 then RS256, the two every platform authenticator offers.
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
        }),
      );
    },
    completeRegistration: (
      input: Readonly<{
        email: string;
        accessToken: string;
        credential: PartnerPasskeyRegistrationCredential;
      }>,
    ) => {
      const address = input.email.trim().toLowerCase();
      if (
        !constantTimeEqual(
          input.accessToken,
          syntheticPartnerAccessToken(address),
        )
      ) {
        return Promise.reject(
          new PartnerOtpError(
            'PARTNER_SIGN_IN_REFUSED',
            'The partner sign-in details were not accepted.',
          ),
        );
      }
      const issued = syntheticState().registrations.get(address);
      // One ceremony, one credential: the challenge is spent whether or not
      // the credential is accepted.
      syntheticState().registrations.delete(address);
      const clientData = readSyntheticClientData(
        input.credential.response.clientDataJSON,
      );
      if (
        issued === undefined ||
        clientData === null ||
        clientData.type !== 'webauthn.create' ||
        !constantTimeEqual(clientData.challenge, issued)
      ) {
        return Promise.reject(
          new PartnerOtpError(
            'PARTNER_SIGN_IN_REFUSED',
            'The partner sign-in details were not accepted.',
          ),
        );
      }
      const registered =
        syntheticState().credentials.get(address) ?? new Set<string>();
      registered.add(input.credential.id);
      syntheticState().credentials.set(address, registered);
      return Promise.resolve();
    },
  });
}

/** Decodes client data without checking the origin, which the route checks. */
function readSyntheticClientData(
  clientDataJSON: string,
): PartnerPasskeyClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(clientDataJSON, 'base64url').toString('utf8'),
    ) as unknown;
  } catch {
    return null;
  }
  const clientData = PartnerPasskeyClientDataSchema.safeParse(parsed);
  return clientData.success ? clientData.data : null;
}

const cognitoPartnerPasskeyProviders = new Map<
  string,
  PartnerPasskeyProvider
>();

/**
 * The partner passkey provider this deployment is configured for, or null
 * when this deployment has no partner sign-in path at all. Callers answer a
 * null exactly as they answer a deployment without partner access.
 */
export function resolvePartnerPasskeyProvider(
  environment: Environment = process.env,
): PartnerPasskeyProvider | null {
  const configuration = readPartnerPoolConfiguration(environment);
  if (configuration === null) {
    return null;
  }
  if (configuration.synthetic) {
    return syntheticPartnerPasskeyProvider(configuration);
  }
  const key = JSON.stringify(configuration);
  const existing = cognitoPartnerPasskeyProviders.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = new CognitoPartnerPasskeyProvider(configuration);
  cognitoPartnerPasskeyProviders.set(key, created);
  return created;
}
