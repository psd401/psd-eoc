# Vendored axe-core test asset

This directory contains an unmodified copy of the browser bundle and license
notices from `axe-core` version 4.12.1. PSD EOC uses the bundle only inside its
Playwright accessibility tests; it is not a production runtime dependency.

## Provenance

- Package: `axe-core@4.12.1`
- Official package archive:
  <https://registry.npmjs.org/axe-core/-/axe-core-4.12.1.tgz>
- Upstream Source Code Form:
  <https://github.com/dequelabs/axe-core/tree/v4.12.1>
- Upstream source archive:
  <https://github.com/dequelabs/axe-core/archive/refs/tags/v4.12.1.tar.gz>
- Package archive SHA-256:
  `4341a01268b5ecbea826f3c7a7d1d69280a2cab3484c93e1bf4c9554460c6ca0`
- Package archive npm integrity:
  `sha512-s7iGf5GaVMxEG0ENN9x+xTr7GFZCb1ZP/1uATUpCEK2X78nDB3RwbtFCo9pGAf9ru+VwoQ464DkaLEeRM08wJA==`
- `axe.min.js` SHA-256:
  `66a8aaa95a8b044a7fd74a5435873bf04ff65a1ca75567c921b7509742085a14`
- `axe.min.js` upstream SRI:
  `sha256-ZqiqqVqLBEp/10pUNYc78E/2WhynVWfJIbdQl0IIWhQ=`
- `LICENSE` SHA-256:
  `af175b9d96ee93c21a036152e1b905b0b95304d4ae8c2c921c7609100ba8df7e`
- `LICENSE-3RD-PARTY.txt` SHA-256:
  `4f8563870d0fca38bbc3e00b6f670cb7fa9f380ba9f26a7f7d1184a6b18b1653`

The upstream file is named `axe.min.js`. This repository stores the exact
bytes as `axe.min.js.txt` so repository formatters and linters do not rewrite
third-party minified code. The Playwright helper reads and injects the file as
JavaScript after verifying its hash.

## License

axe-core is distributed under the Mozilla Public License 2.0. The complete
license is in `LICENSE`, and notices for code bundled by axe-core are in
`LICENSE-3RD-PARTY.txt`. The copyright and MPL notice at the start of the
browser bundle is retained without modification. The pinned upstream links
above identify how recipients can obtain the corresponding Source Code Form.

When upgrading, replace the bundle and both license files from one official
package archive, then update every version, integrity value, and hash in this
notice and in the owned integrity tests.
