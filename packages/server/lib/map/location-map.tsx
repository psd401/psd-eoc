'use client';

import type {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker as MapLibreMarker,
} from 'maplibre-gl';
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
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracyMeters = payload.accuracyMeters;
  const locationRef = useRef({ latitude, longitude, accuracyMeters });
  locationRef.current = { latitude, longitude, accuracyMeters };

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
        const currentLocation = locationRef.current;
        const map = new Map({
          container,
          style: createOsmRasterStyle(),
          center: [currentLocation.longitude, currentLocation.latitude],
          zoom: 17,
          attributionControl: false,
          interactive: mode === 'edit',
          keyboard: false,
        });
        map.getCanvas().tabIndex = -1;
        map.getCanvas().setAttribute('aria-hidden', 'true');

        const markerElement = document.createElement('span');
        markerElement.className = 'location-map-marker';
        markerElement.setAttribute('aria-hidden', 'true');
        const marker = new Marker({
          draggable: mode === 'edit',
          element: markerElement,
        })
          .setLngLat([currentLocation.longitude, currentLocation.latitude])
          .addTo(map);
        mapRef.current = map;
        markerRef.current = marker;

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
          const currentGeometry = createLocationMapGeometry({
            state: 'known',
            ...locationRef.current,
            label: null,
          });
          map.addSource('location-accuracy', {
            type: 'geojson',
            data: currentGeometry.accuracyArea,
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
          mapRef.current = null;
          markerRef.current = null;
          marker.remove();
          map.remove();
        };
      })
      .catch(reportError);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [mode]);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (map === null || marker === null) return;
    const coordinates: [number, number] = [longitude, latitude];
    marker.setLngLat(coordinates);
    const geometry = createLocationMapGeometry({
      state: 'known',
      latitude,
      longitude,
      accuracyMeters,
      label: null,
    });
    const accuracySource = map.getSource('location-accuracy');
    if (accuracySource !== undefined && 'setData' in accuracySource) {
      void (accuracySource as GeoJSONSource).setData(geometry.accuracyArea);
    }
    if (!map.getBounds().contains(coordinates)) {
      map.jumpTo({ center: coordinates });
    }
  }, [accuracyMeters, latitude, longitude]);

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
