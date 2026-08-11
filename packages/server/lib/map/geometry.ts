import type { LocationPayload } from '@psd-eoc/contracts';
import type { MapOptions } from 'maplibre-gl';

export type KnownLocationPayload = Extract<
  LocationPayload,
  Readonly<{ state: 'known' }>
>;

export interface LocationCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

interface PointFeature {
  readonly type: 'Feature';
  readonly properties: Readonly<{ accuracyMeters: number }>;
  readonly geometry: Readonly<{
    type: 'Point';
    coordinates: readonly [number, number];
  }>;
}

interface AccuracyFeature {
  readonly type: 'Feature';
  readonly properties: Readonly<{ accuracyMeters: number }>;
  readonly geometry: Readonly<{
    type: 'Polygon';
    coordinates: readonly (readonly (readonly [number, number])[])[];
  }>;
}

export interface LocationMapGeometry {
  readonly point: PointFeature;
  readonly accuracyArea: AccuracyFeature;
}

export const OSM_RASTER_TILE_TEMPLATE =
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION =
  '© OpenStreetMap contributors (Open Database License)';
export const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
export const GPS_PRECISION_DISCLAIMER =
  'Browser GPS does not establish room-level location.';

const EARTH_RADIUS_METERS = 6_371_008.8;
const ACCURACY_CIRCLE_SEGMENTS = 64;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value: number): number {
  return ((value + 540) % 360) - 180;
}

function accuracyCircleCoordinate(
  payload: KnownLocationPayload,
  bearingRadians: number,
): readonly [number, number] {
  const latitude = degreesToRadians(payload.latitude);
  const longitude = degreesToRadians(payload.longitude);
  const angularDistance = payload.accuracyMeters / EARTH_RADIUS_METERS;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  );
  const destinationLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) -
        Math.sin(latitude) * Math.sin(destinationLatitude),
    );

  return [
    normalizeLongitude(radiansToDegrees(destinationLongitude)),
    radiansToDegrees(destinationLatitude),
  ];
}

export function createLocationMapGeometry(
  payload: KnownLocationPayload,
): LocationMapGeometry {
  const accuracyRing: Array<readonly [number, number]> = [];
  for (let index = 0; index <= ACCURACY_CIRCLE_SEGMENTS; index += 1) {
    accuracyRing.push(
      accuracyCircleCoordinate(
        payload,
        (index / ACCURACY_CIRCLE_SEGMENTS) * Math.PI * 2,
      ),
    );
  }

  return {
    point: {
      type: 'Feature',
      properties: { accuracyMeters: payload.accuracyMeters },
      geometry: {
        type: 'Point',
        coordinates: [payload.longitude, payload.latitude],
      },
    },
    accuracyArea: {
      type: 'Feature',
      properties: { accuracyMeters: payload.accuracyMeters },
      geometry: { type: 'Polygon', coordinates: [accuracyRing] },
    },
  };
}

export function createOsmRasterStyle(): Exclude<
  MapOptions['style'],
  undefined
> {
  return {
    version: 8,
    sources: {
      'open-street-map': {
        type: 'raster',
        tiles: [OSM_RASTER_TILE_TEMPLATE],
        tileSize: 256,
        attribution: OSM_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: 'open-street-map-raster',
        type: 'raster',
        source: 'open-street-map',
      },
    ],
  };
}

export function formatLocationTextEquivalent(payload: LocationPayload): string {
  if (payload.state === 'known') {
    const label = payload.label ?? 'Recorded location';
    return `${label}: latitude ${payload.latitude}, longitude ${payload.longitude}; GPS accuracy radius ±${payload.accuracyMeters} meters. ${GPS_PRECISION_DISCLAIMER}`;
  }
  if (payload.state === 'ambiguous') {
    return `Ambiguous location: ${payload.label}. Coordinates and accuracy are unavailable. Reason: ${payload.reason}.`;
  }
  return `Location unknown. Coordinates and accuracy are unavailable. Reason: ${payload.reason}.`;
}
