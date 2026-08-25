'use client';

import {
  LocationPayloadSchema,
  type LocationPayload,
} from '@psd-eoc/contracts';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { LocationMap, formatLocationTextEquivalent } from '../../../../lib/map';

export interface LocationDraft {
  readonly state: LocationPayload['state'];
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracyMeters: string;
  readonly label: string;
  readonly reason: string;
}

export const EMPTY_LOCATION_DRAFT: LocationDraft = Object.freeze({
  state: 'unknown',
  latitude: '',
  longitude: '',
  accuracyMeters: '',
  label: '',
  reason: '',
});

export function locationDraftFromPayload(
  payload: LocationPayload,
): LocationDraft {
  if (payload.state === 'known') {
    return {
      state: 'known',
      latitude: String(payload.latitude),
      longitude: String(payload.longitude),
      accuracyMeters: String(payload.accuracyMeters),
      label: payload.label ?? '',
      reason: '',
    };
  }
  if (payload.state === 'ambiguous') {
    return {
      ...EMPTY_LOCATION_DRAFT,
      state: 'ambiguous',
      label: payload.label,
      reason: payload.reason,
    };
  }
  return {
    ...EMPTY_LOCATION_DRAFT,
    reason: payload.reason,
  };
}

export function locationPayloadFromDraft(
  draft: LocationDraft,
): LocationPayload | null {
  let candidate: unknown;
  if (draft.state === 'known') {
    if (
      draft.latitude.trim().length === 0 ||
      draft.longitude.trim().length === 0 ||
      draft.accuracyMeters.trim().length === 0
    ) {
      return null;
    }
    candidate = {
      state: 'known',
      latitude: Number(draft.latitude),
      longitude: Number(draft.longitude),
      accuracyMeters: Number(draft.accuracyMeters),
      label: draft.label.trim().length === 0 ? null : draft.label.trim(),
    };
  } else if (draft.state === 'ambiguous') {
    candidate = {
      state: 'ambiguous',
      label: draft.label.trim(),
      reason: draft.reason.trim(),
    };
  } else {
    candidate = { state: 'unknown', reason: draft.reason.trim() };
  }
  const parsed = LocationPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

class LocationMapBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  public override state = { failed: false };

  public static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="location-map-fallback" role="status">
          Map unavailable. The complete location text remains available.
        </p>
      );
    }
    return this.props.children;
  }
}

function SafeLocationMap({
  payload,
  mode,
  ariaLabel,
  onCoordinatesChange,
}: Readonly<{
  payload: Extract<LocationPayload, { state: 'known' }>;
  mode: 'display' | 'edit';
  ariaLabel: string;
  onCoordinatesChange?: (coordinates: {
    latitude: number;
    longitude: number;
  }) => void;
}>) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="location-map-fallback" role="status">
        Map unavailable. The complete location text and posting controls remain
        available.
      </p>
    );
  }
  return (
    <LocationMapBoundary>
      {mode === 'edit' && onCoordinatesChange !== undefined ? (
        <LocationMap
          ariaLabel={ariaLabel}
          mode="edit"
          onCoordinatesChange={onCoordinatesChange}
          onError={() => setFailed(true)}
          payload={payload}
        />
      ) : (
        <LocationMap
          ariaLabel={ariaLabel}
          mode="display"
          onError={() => setFailed(true)}
          payload={payload}
        />
      )}
    </LocationMapBoundary>
  );
}

export function LocationEditor({
  draft,
  idPrefix,
  onChange,
}: Readonly<{
  draft: LocationDraft;
  idPrefix: string;
  onChange: (draft: LocationDraft) => void;
}>) {
  const [geolocationStatus, setGeolocationStatus] = useState('');
  const [locating, setLocating] = useState(false);
  const geolocationRequestRef = useRef(0);
  const currentDraftRef = useRef(draft);
  currentDraftRef.current = draft;
  const payload = locationPayloadFromDraft(draft);
  const knownPayload = payload?.state === 'known' ? payload : null;

  useEffect(
    () => () => {
      geolocationRequestRef.current += 1;
    },
    [],
  );

  function update(patch: Partial<LocationDraft>): void {
    const nextDraft = { ...draft, ...patch };
    currentDraftRef.current = nextDraft;
    onChange(nextDraft);
  }

  function changeState(
    state: LocationPayload['state'],
    patch: Partial<LocationDraft> = {},
  ): void {
    geolocationRequestRef.current += 1;
    if (locating) {
      setLocating(false);
      setGeolocationStatus(
        'The pending device-location result was ignored after the location state changed.',
      );
    }
    update({ state, ...patch });
  }

  function requestCurrentLocation(): void {
    if (locating) return;
    if (!('geolocation' in navigator)) {
      setGeolocationStatus(
        'This browser cannot provide a device location. Choose ambiguous or unknown instead.',
      );
      return;
    }
    setLocating(true);
    setGeolocationStatus('Requesting the current device location…');
    const requestGeneration = geolocationRequestRef.current + 1;
    geolocationRequestRef.current = requestGeneration;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (geolocationRequestRef.current !== requestGeneration) return;
        const currentDraft = currentDraftRef.current;
        if (currentDraft.state !== 'known') return;
        const captured = LocationPayloadSchema.safeParse({
          state: 'known',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          label:
            currentDraft.label.trim().length === 0
              ? null
              : currentDraft.label.trim(),
        });
        setLocating(false);
        if (!captured.success || captured.data.state !== 'known') {
          setGeolocationStatus(
            'The browser returned invalid location evidence. Nothing was posted; choose ambiguous or unknown instead.',
          );
          return;
        }
        onChange(locationDraftFromPayload(captured.data));
        setGeolocationStatus(
          'Device location captured. Review the accuracy radius and correct the pin before posting.',
        );
      },
      () => {
        if (geolocationRequestRef.current !== requestGeneration) return;
        setLocating(false);
        setGeolocationStatus(
          'The device location was not available. Nothing was posted; choose ambiguous or unknown instead.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  }

  return (
    <div className="location-editor">
      <fieldset className="location-state-options">
        <legend>Location certainty</legend>
        <label>
          <input
            checked={draft.state === 'known'}
            data-autofocus={draft.state === 'known' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('known', { reason: '' })}
            type="radio"
            value="known"
          />{' '}
          Known coordinates
        </label>
        <label>
          <input
            checked={draft.state === 'ambiguous'}
            data-autofocus={draft.state === 'ambiguous' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('ambiguous')}
            type="radio"
            value="ambiguous"
          />{' '}
          Ambiguous location
        </label>
        <label>
          <input
            checked={draft.state === 'unknown'}
            data-autofocus={draft.state === 'unknown' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('unknown', { label: '' })}
            type="radio"
            value="unknown"
          />{' '}
          Unknown location
        </label>
      </fieldset>

      {draft.state === 'known' ? (
        <>
          <button
            className="secondary"
            disabled={locating}
            onClick={requestCurrentLocation}
            type="button"
          >
            {locating ? 'Locating device…' : 'Use current device location'}
          </button>
          <p className="field-help">
            GPS accuracy is a radius and never establishes room-level precision.
            Review the visible radius, then drag the pin or edit the coordinates
            before posting.
          </p>
          <div className="location-coordinate-grid">
            <div className="field">
              <label htmlFor={`${idPrefix}-latitude`}>Latitude</label>
              <input
                id={`${idPrefix}-latitude`}
                max={90}
                min={-90}
                onChange={(change) =>
                  update({ latitude: change.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={draft.latitude}
              />
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-longitude`}>Longitude</label>
              <input
                id={`${idPrefix}-longitude`}
                max={180}
                min={-180}
                onChange={(change) =>
                  update({ longitude: change.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={draft.longitude}
              />
            </div>
          </div>
          <p className="location-accuracy" role="status">
            Accuracy radius:{' '}
            <strong>
              {draft.accuracyMeters.trim().length === 0
                ? 'not captured'
                : `±${draft.accuracyMeters} meters`}
            </strong>
          </p>
          <div className="field">
            <label htmlFor={`${idPrefix}-label`}>
              Location label (optional)
            </label>
            <input
              id={`${idPrefix}-label`}
              maxLength={200}
              onChange={(change) => update({ label: change.target.value })}
              type="text"
              value={draft.label}
            />
          </div>
          {knownPayload === null ? (
            <p className="location-map-fallback">
              Capture a device location to establish its accuracy radius. A
              known location cannot be posted without that evidence.
            </p>
          ) : (
            <SafeLocationMap
              ariaLabel="Adjustable location pin and browser accuracy radius"
              mode="edit"
              onCoordinatesChange={(coordinates) =>
                update({
                  latitude: String(coordinates.latitude),
                  longitude: String(coordinates.longitude),
                })
              }
              payload={knownPayload}
            />
          )}
        </>
      ) : draft.state === 'ambiguous' ? (
        <>
          <div className="field">
            <label htmlFor={`${idPrefix}-label`}>Best available label</label>
            <input
              id={`${idPrefix}-label`}
              maxLength={200}
              onChange={(change) => update({ label: change.target.value })}
              required
              type="text"
              value={draft.label}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-reason`}>
              Why the location is ambiguous
            </label>
            <textarea
              id={`${idPrefix}-reason`}
              maxLength={500}
              onChange={(change) => update({ reason: change.target.value })}
              required
              value={draft.reason}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor={`${idPrefix}-reason`}>
            Why the location is unknown
          </label>
          <textarea
            id={`${idPrefix}-reason`}
            maxLength={500}
            onChange={(change) => update({ reason: change.target.value })}
            required
            value={draft.reason}
          />
        </div>
      )}
      <p aria-atomic="true" aria-live="polite" className="location-status">
        {geolocationStatus}
      </p>
    </div>
  );
}

export function LocationEntryContent({
  entryId,
  entrySequence,
  mapVisible,
  onToggleMap,
  payload,
}: Readonly<{
  entryId: string;
  entrySequence: number;
  mapVisible: boolean;
  onToggleMap: () => void;
  payload: LocationPayload;
}>) {
  const mapId = `location-map-${entryId}`;
  return (
    <div className="entry-content location-entry-content">
      <p className="location-text-equivalent">
        {formatLocationTextEquivalent(payload)}
      </p>
      {payload.state === 'known' ? (
        <>
          <button
            aria-controls={mapId}
            aria-expanded={mapVisible}
            className="secondary location-map-toggle"
            onClick={onToggleMap}
            type="button"
          >
            {mapVisible ? 'Hide' : 'Show'} map for entry {entrySequence}
          </button>
          <div hidden={!mapVisible} id={mapId}>
            {mapVisible ? (
              <SafeLocationMap
                ariaLabel={`Posted location pin and accuracy radius for entry ${entrySequence}`}
                mode="display"
                payload={payload}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
