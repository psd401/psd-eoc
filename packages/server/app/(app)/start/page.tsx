import {
  FacilityIdSchema,
  OperatorDetailSchema,
  ThreatIdSchema,
  type EventTypeListItem,
  type Facility,
  type TemplateMode,
  type Threat,
} from '@psd-eoc/contracts';
import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { eventTypesForMode, loadOperationalViewData } from './_lib/data';
import {
  startConfirmationReturnPath,
  startResponseReturnPath,
  startSelectionReturnPath,
} from './_lib/return-path';
import { requirePageSession } from './_lib/session';
import { Call911Affordance } from './components/call-911-affordance';
import { ClassificationBanner } from './components/classification-banner';
import { ClassificationIcon } from './components/classification-icon';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchValue = string | readonly string[] | undefined;

interface SelectEventTypePageProps {
  readonly searchParams: Promise<
    Readonly<{
      facilityId?: SearchValue;
      mode?: SearchValue;
      threatId?: SearchValue;
      threatDetail?: SearchValue;
    }>
  >;
}

function one(value: SearchValue): string | null {
  return typeof value === 'string' ? value : null;
}

const DETAIL_MAX_LENGTH = 200;

async function StartFacilityPage() {
  const authenticated = await requirePageSession('/start');
  const data = await loadOperationalViewData(authenticated);

  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Staff emergency operations</p>
          <h1>Start an event</h1>
          <p className="lede">
            Choose a site and whether this is a real incident or a drill.
            Choosing here does not start an event or notify anyone.
          </p>
        </div>
        <Link className="button button--secondary" href="/">
          Return to active events
        </Link>
      </header>

      <Call911Affordance />

      <section aria-labelledby="start-site-heading">
        <div className="section-heading">
          <h2 id="start-site-heading">Choose site and mode</h2>
          <span className="step-hint">Step 1 of 4</span>
        </div>
        <div className="dashboard-grid">
          {data.facilities.map((facility) => (
            <article className="facility-card" key={facility.id}>
              <p className="facility-code">{facility.code}</p>
              <h3>{facility.name}</h3>
              <div className="action-grid">
                <a
                  aria-label={`Start REAL incident at ${facility.name}`}
                  className="action-link action-link--real"
                  href={startSelectionReturnPath({
                    facilityId: facility.id,
                    mode: 'real',
                  })}
                >
                  <ClassificationIcon mode="real" />
                  <span>
                    Start <strong>REAL incident</strong>
                  </span>
                </a>
                <a
                  aria-label={`Run DRILL at ${facility.name}`}
                  className="action-link action-link--drill"
                  href={startSelectionReturnPath({
                    facilityId: facility.id,
                    mode: 'drill',
                  })}
                >
                  <ClassificationIcon mode="drill" />
                  <span>
                    Run <strong>DRILL</strong>
                  </span>
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export async function generateMetadata({
  searchParams,
}: SelectEventTypePageProps): Promise<Metadata> {
  const parameters = await searchParams;
  const facilityId = one(parameters.facilityId);
  const mode = one(parameters.mode);
  const threatId = one(parameters.threatId);
  const modeWord =
    mode === 'real' ? 'REAL incident' : mode === 'drill' ? 'DRILL' : null;
  return {
    title:
      facilityId === null && mode === null
        ? 'Start an event'
        : modeWord === null
          ? threatId === null
            ? 'Choose threat'
            : 'Choose response'
          : threatId === null
            ? `Choose ${modeWord} threat`
            : `Choose ${modeWord} response`,
  };
}

interface StepShellProps {
  readonly children: React.ReactNode;
  readonly facility: Facility;
  readonly heading: string;
  readonly mode: TemplateMode;
  readonly step: 2 | 3;
  readonly backHref: string;
  readonly backLabel: string;
}

/** The chrome every selection step shares: progress, heading, banner, 911. */
function StepShell({
  backHref,
  backLabel,
  children,
  facility,
  heading,
  mode,
  step,
}: StepShellProps) {
  const otherMode = mode === 'real' ? 'drill' : 'real';
  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <nav aria-label="Start-event progress">
        <ol className="step-list">
          <li className="step-list__complete">1. Site and mode chosen</li>
          <li
            aria-current={step === 2 ? 'step' : undefined}
            className={step > 2 ? 'step-list__complete' : undefined}
          >
            2. {step > 2 ? 'Threat chosen' : 'Choose threat'}
          </li>
          <li aria-current={step === 3 ? 'step' : undefined}>
            3. Choose response
          </li>
          <li>4. Review and confirm</li>
        </ol>
      </nav>

      <header className="page-heading">
        <div>
          <p className="eyebrow">{facility.code}</p>
          <h1>{heading}</h1>
          <p className="lede">{facility.name}</p>
        </div>
        <Link className="button button--secondary" href={backHref}>
          {backLabel}
        </Link>
      </header>

      <ClassificationBanner
        mode={mode}
        detail={
          mode === 'real'
            ? 'This path is for an actual emergency. The confirmation step can notify staff.'
            : 'This path is training only. Every screen and message remains marked DRILL.'
        }
      />

      <Call911Affordance />

      <nav className="mode-switch" aria-label="Event mode">
        <Link
          aria-current={mode === 'real' ? 'page' : undefined}
          className="mode-switch__real"
          href={startSelectionReturnPath({
            facilityId: facility.id,
            mode: 'real',
          })}
        >
          <ClassificationIcon mode="real" /> REAL incident
        </Link>
        <Link
          aria-current={mode === 'drill' ? 'page' : undefined}
          className="mode-switch__drill"
          href={startSelectionReturnPath({
            facilityId: facility.id,
            mode: 'drill',
          })}
        >
          <ClassificationIcon mode="drill" /> DRILL — training only
        </Link>
      </nav>
      <p className="supporting-text">
        Switching to {otherMode === 'real' ? 'REAL incident' : 'DRILL'} mode
        restarts the threat choice and does not start an event.
      </p>

      {children}
    </main>
  );
}

interface ThreatStepProps {
  readonly facility: Facility;
  readonly mode: TemplateMode;
  readonly threats: readonly Threat[];
  /** A threat whose required description was missing or unusable. */
  readonly detailProblem: Readonly<{ threatId: string; draft: string }> | null;
}

function ThreatStep({
  detailProblem,
  facility,
  mode,
  threats,
}: ThreatStepProps) {
  const cardClass = `choice-card ${
    mode === 'real' ? 'choice-card--real' : 'choice-card--drill'
  }`;
  return (
    <StepShell
      backHref="/"
      backLabel="Change site"
      facility={facility}
      heading="Choose threat"
      mode={mode}
      step={2}
    >
      <section aria-labelledby="threat-heading">
        <h2 id="threat-heading">What is the threat?</h2>
        <p className="supporting-text">
          Choosing a threat does not start an event or notify anyone. You choose
          the response next.
        </p>
        {threats.length === 0 ? (
          <div className="error-summary" role="alert">
            <h3>No threats are configured</h3>
            <p>
              No event was started. Contact a PSD EOC administrator before
              continuing.
            </p>
          </div>
        ) : (
          <div className="choice-grid">
            {threats.map((threat) => {
              if (!threat.requiresDetail) {
                return (
                  <Link
                    className={cardClass}
                    href={startResponseReturnPath({
                      facilityId: facility.id,
                      mode,
                      threatId: threat.id,
                      threatDetail: null,
                    })}
                    key={threat.id}
                  >
                    <span className="choice-card__icon" aria-hidden="true">
                      <ClassificationIcon mode={mode} />
                    </span>
                    <span className="choice-card__copy">
                      <strong className="choice-card__label">
                        {threat.name}
                      </strong>
                    </span>
                  </Link>
                );
              }
              const inputId = `threat-detail-${threat.id}`;
              const problem =
                detailProblem?.threatId === threat.id ? detailProblem : null;
              return (
                <form
                  action="/start"
                  aria-labelledby={`${inputId}-label`}
                  className={`${cardClass} choice-card--detail`}
                  key={threat.id}
                  method="get"
                >
                  <input name="facilityId" type="hidden" value={facility.id} />
                  <input name="mode" type="hidden" value={mode} />
                  <input name="threatId" type="hidden" value={threat.id} />
                  <span className="choice-card__copy">
                    <strong
                      className="choice-card__label"
                      id={`${inputId}-label`}
                    >
                      {threat.name}
                    </strong>
                    <small className="choice-card__detail">
                      Describe the threat in a few words. Staff see exactly what
                      you type.
                    </small>
                  </span>
                  <label className="field-label" htmlFor={inputId}>
                    Describe the threat
                  </label>
                  <input
                    aria-describedby={
                      problem === null ? undefined : `${inputId}-error`
                    }
                    aria-invalid={problem === null ? undefined : true}
                    autoComplete="off"
                    defaultValue={problem?.draft ?? ''}
                    id={inputId}
                    maxLength={DETAIL_MAX_LENGTH}
                    name="threatDetail"
                    required
                    type="text"
                  />
                  {problem === null ? null : (
                    <p
                      className="field-error"
                      id={`${inputId}-error`}
                      role="alert"
                    >
                      Type a short description of the threat before continuing.
                      Up to {DETAIL_MAX_LENGTH} plain characters.
                    </p>
                  )}
                  <button className="button" type="submit">
                    Continue with {threat.name}
                  </button>
                </form>
              );
            })}
          </div>
        )}
      </section>
    </StepShell>
  );
}

interface ResponseStepProps {
  readonly facility: Facility;
  readonly mode: TemplateMode;
  readonly threat: Threat;
  readonly threatDetail: string | null;
  readonly eventTypes: readonly EventTypeListItem[];
}

function ResponseStep({
  eventTypes,
  facility,
  mode,
  threat,
  threatDetail,
}: ResponseStepProps) {
  const cardClass = `choice-card ${
    mode === 'real' ? 'choice-card--real' : 'choice-card--drill'
  }`;
  const threatHref = startSelectionReturnPath({
    facilityId: facility.id,
    mode,
  });
  return (
    <StepShell
      backHref={threatHref}
      backLabel="Change threat"
      facility={facility}
      heading="Choose response"
      mode={mode}
      step={3}
    >
      <section aria-labelledby="response-heading">
        <p className="chosen-threat">
          <span className="chosen-threat__label">Threat</span>{' '}
          <strong>{threat.name}</strong>
          {threatDetail === null ? null : ` — ${threatDetail}`}
        </p>
        <h2 id="response-heading">
          {mode === 'real' ? 'Real incident response' : 'Drill response'}
        </h2>
        <p className="supporting-text">
          The response decides what staff are told to do. Choosing one loads a
          preview of who would be notified; nothing is sent yet.
        </p>
        {eventTypes.length === 0 ? (
          <div className="error-summary" role="alert">
            <h3>No enabled responses</h3>
            <p>
              No event was started. Contact a PSD EOC administrator before
              continuing.
            </p>
          </div>
        ) : (
          <div className="choice-grid">
            {eventTypes.map((item) => {
              if (!item.eventType.requiresDetail) {
                return (
                  <Link
                    className={cardClass}
                    href={startConfirmationReturnPath({
                      eventTypeVersionId: item.latestVersion.id,
                      facilityId: facility.id,
                      mode,
                      threatId: threat.id,
                      threatDetail,
                      responseDetail: null,
                    })}
                    key={item.eventType.id}
                  >
                    <span className="choice-card__icon" aria-hidden="true">
                      <ClassificationIcon mode={mode} />
                    </span>
                    <span className="choice-card__copy">
                      <strong className="choice-card__label">
                        {item.latestVersion.name}
                      </strong>
                      {item.latestVersion.description === null ? null : (
                        <>
                          {' '}
                          <small className="choice-card__detail">
                            {item.latestVersion.description}
                          </small>
                        </>
                      )}
                    </span>
                  </Link>
                );
              }
              const inputId = `response-detail-${item.eventType.id}`;
              return (
                <form
                  action="/start/confirm"
                  aria-labelledby={`${inputId}-label`}
                  className={`${cardClass} choice-card--detail`}
                  key={item.eventType.id}
                  method="get"
                >
                  <input name="facilityId" type="hidden" value={facility.id} />
                  <input name="mode" type="hidden" value={mode} />
                  <input name="threatId" type="hidden" value={threat.id} />
                  {threatDetail === null ? null : (
                    <input
                      name="threatDetail"
                      type="hidden"
                      value={threatDetail}
                    />
                  )}
                  <input
                    name="eventTypeVersionId"
                    type="hidden"
                    value={item.latestVersion.id}
                  />
                  <span className="choice-card__copy">
                    <strong
                      className="choice-card__label"
                      id={`${inputId}-label`}
                    >
                      {item.latestVersion.name}
                    </strong>
                    <small className="choice-card__detail">
                      Describe the response in a few words. It replaces the
                      response name in every notification.
                    </small>
                  </span>
                  <label className="field-label" htmlFor={inputId}>
                    Describe the response
                  </label>
                  <input
                    autoComplete="off"
                    id={inputId}
                    maxLength={DETAIL_MAX_LENGTH}
                    name="responseDetail"
                    required
                    type="text"
                  />
                  <button className="button" type="submit">
                    Continue with {item.latestVersion.name}
                  </button>
                </form>
              );
            })}
          </div>
        )}
      </section>
    </StepShell>
  );
}

export default async function SelectEventTypePage({
  searchParams,
}: SelectEventTypePageProps) {
  const parameters = await searchParams;
  const facilityValue = one(parameters.facilityId);
  const mode = one(parameters.mode);
  if (facilityValue === null && mode === null) {
    return <StartFacilityPage />;
  }
  const facilityResult = FacilityIdSchema.safeParse(facilityValue);
  if (!facilityResult.success || (mode !== 'real' && mode !== 'drill')) {
    redirect('/start');
  }

  const threatValue = one(parameters.threatId);
  const returnPath =
    threatValue === null
      ? startSelectionReturnPath({ facilityId: facilityResult.data, mode })
      : startSelectionReturnPath({ facilityId: facilityResult.data, mode });
  const authenticated = await requirePageSession(returnPath);
  const data = await loadOperationalViewData(authenticated);
  const facility = data.facilities.find(
    (candidate) => candidate.id === facilityResult.data,
  );
  if (facility === undefined) {
    redirect('/');
  }

  if (threatValue === null) {
    return (
      <ThreatStep
        detailProblem={null}
        facility={facility}
        mode={mode}
        threats={data.threats}
      />
    );
  }

  const threatResult = ThreatIdSchema.safeParse(threatValue);
  const threat =
    threatResult.success && !Array.isArray(threatResult.data)
      ? data.threats.find((candidate) => candidate.id === threatResult.data)
      : undefined;
  if (threat === undefined) {
    redirect(startSelectionReturnPath({ facilityId: facility.id, mode }));
  }

  const detailValue = one(parameters.threatDetail);
  const detailResult = OperatorDetailSchema.safeParse(detailValue);
  if (threat.requiresDetail && !detailResult.success) {
    return (
      <ThreatStep
        detailProblem={{ threatId: threat.id, draft: detailValue ?? '' }}
        facility={facility}
        mode={mode}
        threats={data.threats}
      />
    );
  }

  return (
    <ResponseStep
      eventTypes={eventTypesForMode(data.eventTypes, mode)}
      facility={facility}
      mode={mode}
      threat={threat}
      threatDetail={
        threat.requiresDetail && detailResult.success ? detailResult.data : null
      }
    />
  );
}
