# Noto Sans PDF font asset

`NotoSans-Regular.ttf` is the unmodified hinted Noto Sans Regular font used
for PSD EOC event-summary PDFs. It is embedded into each generated PDF so its
supported Unicode text renders consistently without a host font dependency.
The renderer checks every code point against this exact font and emits a
visible `[U+....]` marker when no glyph exists, so retained content is never
silently omitted.

- Source repository: `notofonts/noto-fonts`
- Source commit: `ffebf8c1ee449e544955a7e813c54f9b73848eac`
- Source path: `hinted/ttf/NotoSans/NotoSans-Regular.ttf`
- SHA-256: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`
- License: SIL Open Font License 1.1; see `OFL.txt`
