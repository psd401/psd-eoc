import {
  type ClientDiagnosticReport,
  type ClientFailureKind,
  MAX_CLIENT_DIAGNOSTIC_REPORTS,
} from '@psd-eoc/contracts';

/** The route diagnostics are posted to, and the one never reported about. */
export const CLIENT_DIAGNOSTIC_PATH = '/api/diagnostics';

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Reduces a request path to the shape of its route.
 *
 * A diagnostic has to be safe to log verbatim, because one that is not does not
 * get read during an incident. Any segment that identifies something -- a UUID,
 * an opaque token-like value, anything long enough to be an identifier -- is
 * replaced, so a report says `/events/:id/api` and never which event.
 */
export function routeShape(path: string): string {
  const [withoutQuery = ''] = path.split('?');
  const shaped = withoutQuery
    .split('/')
    .map((segment) => {
      if (segment.length === 0) return segment;
      if (UUID_SEGMENT.test(segment)) return ':id';
      if (segment.length > 24) return ':id';
      if (/\d/u.test(segment) && /^[A-Za-z0-9._-]+$/u.test(segment)) {
        return /^[A-Za-z-]+$/u.test(segment) ? segment : ':id';
      }
      return segment;
    })
    .join('/');
  return shaped.length === 0 ? '/' : shaped;
}

export interface ClientDiagnosticsTransport {
  send(reports: readonly ClientDiagnosticReport[]): Promise<void>;
}

export interface ClientDiagnosticsBuildIdentity {
  readonly applicationVersion: string | null;
  readonly nativeBuildVersion: string | null;
  readonly platform: 'ios' | 'android';
}

/**
 * Reports what the client saw when a request failed.
 *
 * Nothing the server logs can explain a request it never received. An emergency
 * drill ran with the phone showing an unavailable timeline while the server
 * recorded nothing at all, because the failing requests never arrived. Only the
 * client witnessed those, so only the client can report them.
 *
 * Reporting never blocks or fails a real request: a failed report is dropped.
 * The alternative -- retrying telemetry -- risks spending an operator's
 * connection on diagnostics during the emergency the diagnostics are about.
 */
export class ClientDiagnostics {
  #queued: ClientDiagnosticReport[] = [];
  #sending = false;

  public constructor(
    private readonly transport: ClientDiagnosticsTransport,
    private readonly identity: () => ClientDiagnosticsBuildIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public report(
    input: Readonly<{
      kind: ClientFailureKind;
      method: ClientDiagnosticReport['method'];
      path: string;
      status: number | null;
      requestId: string | null;
    }>,
  ): void {
    const shape = routeShape(input.path);
    // Never report a failure of the reporting route: that is the one loop this
    // must not have.
    if (shape === CLIENT_DIAGNOSTIC_PATH) return;
    const build = this.identity();
    this.#queued.push({
      kind: input.kind,
      method: input.method,
      routeShape: shape,
      status: input.status,
      requestId: input.requestId,
      surface: 'mobile',
      applicationVersion: build.applicationVersion,
      nativeBuildVersion: build.nativeBuildVersion,
      platform: build.platform,
      occurredAt: this.now().toISOString(),
    });
    if (this.#queued.length > MAX_CLIENT_DIAGNOSTIC_REPORTS) {
      // Keep the newest: during a sustained outage the recent failures are the
      // ones that describe what is happening now.
      this.#queued = this.#queued.slice(-MAX_CLIENT_DIAGNOSTIC_REPORTS);
    }
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#sending || this.#queued.length === 0) return;
    this.#sending = true;
    const batch = this.#queued;
    this.#queued = [];
    try {
      await this.transport.send(batch);
    } catch {
      // Dropped on purpose. Telemetry must never become the reason a device
      // spends its connection, and must never surface an error of its own.
    } finally {
      this.#sending = false;
    }
  }
}
