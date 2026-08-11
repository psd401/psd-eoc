'use client';

import { useEffect, useRef } from 'react';

import {
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  createLocationMapGeometry,
  createOsmRasterStyle,
  type KnownLocationPayload,
  type LocationCoordinates,
} from './geometry';

export interface LocationMapProps {
  readonly payload: KnownLocationPayload;
  readonly mode: 'display' | 'edit';
  readonly onCoordinatesChange?: (coordinates: LocationCoordinates) => void;
  readonly ariaLabel: string;
  readonly onError?: (error: Error) => void;
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('The optional location map could not be rendered.');
}

export function LocationMap({
  payload,
  mode,
  onCoordinatesChange,
  ariaLabel,
  onError,
}: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const coordinateCallbackRef = useRef(onCoordinatesChange);
  const errorCallbackRef = useRef(onError);
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracyMeters = payload.accuracyMeters;

  useEffect(() => {
    coordinateCallbackRef.current = onCoordinatesChange;
  }, [onCoordinatesChange]);
  useEffect(() => {
    errorCallbackRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let cancelled = false;
    let cleanup = () => undefined;
    let reportedError = false;
    const reportError = (value: unknown) => {
      if (reportedError || cancelled) return;
      reportedError = true;
      errorCallbackRef.current?.(errorFromUnknown(value));
    };

    void import('maplibre-gl')
      .then(({ Map, Marker }) => {
        if (cancelled) return;
        const geometry = createLocationMapGeometry({
          state: 'known',
          latitude,
          longitude,
          accuracyMeters,
          label: null,
        });
        const map = new Map({
          container,
          style: createOsmRasterStyle(),
          center: [longitude, latitude],
          zoom: 17,
          attributionControl: false,
          interactive: mode === 'edit',
        });

        const markerElement = document.createElement('span');
        markerElement.className = 'location-map-marker';
        markerElement.setAttribute('aria-hidden', 'true');
        const marker = new Marker({
          draggable: mode === 'edit',
          element: markerElement,
        })
          .setLngLat([longitude, latitude])
          .addTo(map);

        if (mode === 'edit') {
          marker.on('dragend', () => {
            const position = marker.getLngLat();
            coordinateCallbackRef.current?.({
              latitude: position.lat,
              longitude: position.lng,
            });
          });
        }

        map.on('load', () => {
          if (cancelled) return;
          map.addSource('location-accuracy', {
            type: 'geojson',
            data: geometry.accuracyArea,
          });
          map.addLayer({
            id: 'location-accuracy-fill',
            type: 'fill',
            source: 'location-accuracy',
            paint: {
              'fill-color': '#005ea8',
              'fill-opacity': 0.2,
              'fill-outline-color': '#003e73',
            },
          });
        });
        map.on('error', (event) => reportError(event.error));

        cleanup = () => {
          marker.remove();
          map.remove();
        };
      })
      .catch(reportError);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [accuracyMeters, latitude, longitude, mode]);

  return (
    <div className="location-map-frame">
      <div
        aria-label={ariaLabel}
        className="location-map-canvas"
        ref={containerRef}
        role="img"
      />
      <p className="location-map-attribution">
        <a href={OSM_ATTRIBUTION_URL} rel="noreferrer" target="_blank">
          {OSM_ATTRIBUTION}
        </a>
      </p>
    </div>
  );
}
