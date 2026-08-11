import { describe, expect, test } from 'bun:test';
import { LocationPayloadSchema } from '@psd-eoc/contracts';

import {
  GPS_PRECISION_DISCLAIMER,
  OSM_RASTER_TILE_TEMPLATE,
  createLocationMapGeometry,
  createOsmRasterStyle,
  formatLocationTextEquivalent,
} from './geometry';

const KNOWN = LocationPayloadSchema.parse({
  state: 'known',
  latitude: 47.383,
  longitude: -122.58,
  accuracyMeters: 42.5,
  label: 'Synthetic north entrance',
});
if (KNOWN.state !== 'known') throw new Error('Expected a known location.');

describe('location map helpers', () => {
  test('builds a closed geographic accuracy radius around the exact pin', () => {
    const geometry = createLocationMapGeometry(KNOWN);
    const ring = geometry.accuracyArea.geometry.coordinates[0];

    expect(geometry.point.geometry.coordinates).toEqual([
      KNOWN.longitude,
      KNOWN.latitude,
    ]);
    expect(geometry.point.properties.accuracyMeters).toBe(42.5);
    expect(ring).toHaveLength(65);
    expect(ring?.[0]).toEqual(ring?.at(-1));
    for (const coordinate of ring ?? []) {
      expect(coordinate[0]).toBeWithin(-180, 180);
      expect(coordinate[1]).toBeWithin(-90, 90);
    }
  });

  test('vendors the OSM raster style configuration without a remote style fetch', () => {
    const style = createOsmRasterStyle();
    expect(style).not.toBeString();
    expect(style).toMatchObject({
      version: 8,
      sources: {
        'open-street-map': {
          type: 'raster',
          tiles: [OSM_RASTER_TILE_TEMPLATE],
        },
      },
    });
  });

  test('formats a permanent text equivalent for known, ambiguous, and unknown states', () => {
    const recordedAt = '2026-08-11T15:00:00.000Z';
    expect(formatLocationTextEquivalent(KNOWN, recordedAt)).toContain(
      'GPS accuracy radius ±42.5 meters',
    );
    expect(formatLocationTextEquivalent(KNOWN, recordedAt)).toContain(
      GPS_PRECISION_DISCLAIMER,
    );
    expect(formatLocationTextEquivalent(KNOWN, recordedAt)).toContain(
      recordedAt,
    );
    expect(
      formatLocationTextEquivalent(
        { ...KNOWN, accuracyMeters: 0.04 },
        recordedAt,
      ),
    ).toContain('GPS accuracy radius ±0.04 meters');
    expect(
      formatLocationTextEquivalent(
        LocationPayloadSchema.parse({
          state: 'ambiguous',
          label: 'Near the synthetic gym',
          reason: 'Signal drift crosses two buildings.',
        }),
        recordedAt,
      ),
    ).toContain('Coordinates and accuracy are unavailable');
    expect(
      formatLocationTextEquivalent(
        LocationPayloadSchema.parse({
          state: 'unknown',
          reason: 'The operator cannot safely determine the location.',
        }),
        recordedAt,
      ),
    ).toContain('Location unknown');
  });
});
