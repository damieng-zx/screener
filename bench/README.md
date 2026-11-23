# Bench and render harnesses

These are not shipped; they exist to make the converter's behaviour checkable.

- `bench.ts` — pipeline invariants (.scr size, attribute legality, round-trip)
- `ui.ts` — jsdom smoke test of the real page's wiring
- `layers.ts` — ownership, blending, masks, state files
- `vignette.ts` — vignette geometry
- `layout.ts` — measures the real page in Chromium (`npm run layout`)
- `e2e.ts`, `render.ts`, `layerRender.ts`, `composite.ts`, `singleCells.ts` — visual output
- `samples.ts` — generates the sample images
- `png.ts` — shared PNG writer used by the render scripts

Every `*.ts` here bundles to `*.mjs` next to it; those and the `*.png` outputs are
gitignored build artefacts.
