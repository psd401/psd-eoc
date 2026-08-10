import {
  assertNoAmbientTransportOverrides,
  assertTrustedHome,
} from './runtime';

assertTrustedHome();
assertNoAmbientTransportOverrides();
