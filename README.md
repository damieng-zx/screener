# Spectrum Screener

Turn a PNG, JPEG or WebP into an authentic ZX Spectrum screen — 256×192, 15 colours,
**two per 8×8 cell** — with live control over tone, colour, dithering and attribute clash.
Everything runs in the browser; no upload, no server.

```bash
npm install
npm run dev      # http://localhost:6912 — drop an image, or use the built-in samples
npm run check    # pipeline invariants + UI smoke test
npm run e2e      # convert a real PNG end to end, write bench/photo-out.png
npm run render   # contact sheet of every method/dither combo
npm run samples  # generate the built-in sample images
```

## The hardware constraint (why this is not just quantisation)

A Spectrum screen is 6912 bytes:

| Region  | Size    | Meaning                                                     |
| ------- | ------- | ----------------------------------------------------------- |
| bitmap  | 6144 B  | 1 bit per pixel, 32 bytes per scanline                      |
| attrs   | 768 B   | one attribute per 8×8 cell: FLASH, BRIGHT, PAPER, INK        |

An attribute picks **two** palette colours for the whole 8×8 cell: ink (bit set) and paper
(bit clear). Both must come from the same half of the palette — all normal or all bright —
except black, which exists in neither half and is legal with either. That is the whole of
*attribute clash*: a third colour inside a cell is impossible.

Palette as used here ([#D7 / #FF levels](https://lospec.com/palette-list/zx-spectrum)):

```
normal  #000000 #0000d7 #d70000 #d700d7 #00d700 #00d7d7 #d7d700 #d7d7d7
bright  –––––––– #0000ff #ff0000 #ff00ff #00ff00 #00ffff #ffff00 #ffffff
```

The bitmap is stored in the ULA's interleaved order — three 64-line blocks, scanlines
interleaved inside each character row:

```js
offset = ((y >> 6) & 3) << 11 | (y & 7) << 8 | ((y >> 3) & 7) << 5 | byteColumn;
```

## Pipeline

1. **Fit** — area-average the source into 256×192 (`fit`, `fill` or `stretch`). Averaging
   rather than nearest-neighbour matters: a photo's high-frequency detail becomes honest
   mid-tones instead of aliased noise that dithering then has to fight.
2. **Adjust** — exposure in linear light, black/white point, then gamma-space contrast and
   gamma, then vibrance/saturation/hue/temperature. Optionally blur, unsharp mask,
   posterise or binarise. Working space is OKLab for every colour decision.
3. **Fit cells** — for each 8×8 cell choose the best legal pair (see methods below).
4. **Cohesion** — let a cell reuse a neighbour's pair when it is nearly as good, which
   reduces distinct attributes and calms cell borders.
5. **Dither** — decide, per pixel, which of its cell's two colours it gets.
6. **Pack** — bitmap + attributes to `.scr`, `.tap`, C, assembler or PNG.

## Cell pair selection

Each candidate pair is scored against the cell's 64 source pixels in OKLab. Four metrics:

| Method | Idea | Looks like |
| --- | --- | --- |
| **Smart** (default) | squared distance from each pixel to the **segment** between the two colours: assumes dithering can mix them in any ratio | detailed, photographic |
| **Exhaustive** | nearest of the two colours only, no mixing assumed | crisp, contrasty, noisy |
| **Frequency** | the cell's two most common nearest palette colours (the raytracer approach) | good on flat art |
| **Average** | fit the cell's mean colour exactly | smooth gradients, destroys text |

Two details make "Smart" behave:

- Scoring runs on the real pixel values, not only a histogram binned to the palette. A flat
  cell whose colour is *not* in the palette bins to a single entry, and then every pair
  containing that entry ties at zero distance — the first candidate (usually black) wins by
  accident and flat skies fill with black speckle.
- Pairs pay a small penalty proportional to their segment length. A flat cell ties between
  "blue" and "black + blue" (both reach it exactly), so without the penalty it dithers
  instead of choosing the solid colour. A real gradient more than repays the penalty.

## Dithering

Dithering runs **inside each cell's own colour axis**, in OKLab. A cell can only express the
position `t` of a pixel along the line between its two colours, so we project every pixel onto
that segment and diffuse a single scalar error. Diffusing full RGB error instead leaks each
cell's chromatic error into its neighbours and produces coloured speckle in areas that should
be flat — and it cannot help, because a pair cannot reproduce the component perpendicular to
its own segment. This is the single biggest difference between a decent and a muddy result.

Diffusion kernels, all with serpentine scanning:

| Kernel | Notes |
| --- | --- |
| Floyd–Steinberg | classic, organic |
| Atkinson | only ¾ of the error is passed on: airy, keeps highlights |
| Jarvis–Judice–Ninke | wide and soft |
| Stucki | cleaner and faster converging than Floyd |
| Sierra | between Floyd and Jarvis |

Ordered alternatives: **Bayer 8×8** (one matrix cell per Spectrum cell, so the pattern aligns
with the attribute grid), Bayer 4×4, Bayer 2×2, and hash noise.

Dither **strength** scales the diffused error; 0 collapses to a hard threshold at the midpoint.

An optional **pre-quantise** pass snaps the whole source onto the palette with an ordered
dither before cells are fitted. That is the old-school pipeline and can tame noisy scans, but
it destroys tone, so it is off by default.

## Attribute ergonomics

- **Ink is the minority colour** in each cell, so the bitmap has fewer set bits — which is what
  every ZX screen compressor wants. A cell that dithering filled with one colour collapses to
  a single-colour attribute rather than wasting a second colour.
- **Single-cell bias** discourages (or encourages) one-colour cells; with single-colour cells
  disabled the converter flips a single pixel in any cell that collapsed.
- **BRIGHT** is taken from whichever colour of the pair has a bright variant, so black plus a
  bright colour is legal and comes out bright.
- **FLASH** can be set on a checkerboard or randomly — an aesthetic, not a perceptual choice.

## Stats

- **mean ΔE** — mean OKLab distance from the adjusted (unquantised) source to the result,
  averaged over pixels and scaled ×100. Lower is closer; ~8 on flat art, ~18–25 on photos.
- **distinct attributes** — how varied the palette is across the screen.
- **ink coverage** — fraction of set bits in the bitmap.

## Exports

- `.scr` — raw 6912-byte screen memory (bitmap then attributes), `LOAD "" SCREEN$`-able.
- `.tap` — cassette image with a code block at `0x4000`, loads on hardware and in Fuse/ZEsarUX.
- `.h` / `.asm` — byte arrays in Spectrum screen order.
- `.json` — attributes plus stats, for automated comparisons.
- `.png` — the result at ×3.

## Layers

One picture, several treatments. Each layer carries its own tone, colour, detail and
dithering, and owns a painted region of the source:

- **Add layer**, then paint on the source canvas to claim pixels (Alt/Option erases).
- **Topmost wins** where masks overlap; anything unpainted falls through to the base.
- An attribute covers a whole 8×8 cell, so a **cell follows whichever layer owns most of
  it** — that layer's palette constraints, cell fitting and dither method apply. Each
  *pixel's* own colour pipeline still comes from the layer that owns that pixel, which is
  what lets a crisp logo sit next to a Floyd-dithered photo.
- Error diffusion deliberately crosses region borders, so a dithered region does not end in
  a hard seam against its neighbour.
- Framing (fit/zoom/pan) is a property of the picture, not of a region, so it is not per layer.
- Masks are stored bit-packed and base64'd, so a whole stack fits in `localStorage`.

### Compositing attributes and pixels

On the Spectrum the attribute area and the bitmap are separate memory regions, so the
two-colour *pair* and the *dither pattern* can come from different sources. Each layer's
row has a blend control:

| Mode | Meaning |
| --- | --- |
| `own` | this layer fits its pair **and** dithers it (normal) |
| `attrs from …` | take another layer's colour pair, keep this layer's dither pattern |
| `pixels from …` | keep this layer's pair, take another layer's bit pattern |

`attrs from` is the useful one: colour an image with one layer's palette decisions while
keeping a different dither for the texture. When a layer borrows attributes, the donor fits
its pair against the pixels being coloured rather than only the pixels it owns, so the pair
actually describes the region it is applied to.

Layers are the difference between "one global compromise" and "the sky dithered with Bayer
while the face keeps Floyd–Steinberg and the logo stays flat".

- **Single-colour cells** — when allowed, a cell whose dithering converges on one colour
  becomes a solid attribute, which compresses better. When disallowed, every cell keeps a
  genuine two-colour pair; the bitmap is then simply all-ink or all-paper in cells that
  converge, rather than being nudged with invented pixels.
- **Vignette** is radial, split into density (−1..1, 0 = none) and reach (0..1).

## Layout

The page is one band below the header: the source and Spectrum views (both capped to a
shared height), then a workspace with the layer stack as a fixed sidebar and **five
conversion groups in five fixed tracks on one row** — Spectrum constraints, Dithering, Tone,
Colour, Detail. Nothing may span two tracks, because that would wrap the row and force
scrolling.

`npm run layout` measures the real rendered page in headless Chromium and reports whether it
fits, along with screenshots at 1440×900 and 1280×800. It exists because "the page needs
scrolling" is a layout fact, not something to reason about from CSS by eye.

The header is the title, a **Presets** dropdown, and **Save state / Load state**.

- The Spectrum view is drawn at a **whole-integer scale only** (1×–4×), with the scale buttons
  and the export menu on its label row. A fractional factor would resample the 1-bit pixels
  into grey mush and make dithering impossible to judge.
- **Painting lives in the layer panel**: brush size, fill, invert and clear sit with the layer
  list they act on.
- Everything persists: the layer stack and masks, framing, display scale, and the image.
- **Save state** writes a self-contained `.screener.json` — every layer's options and painted
  mask, framing, and the source image — so a setup can move between machines or be kept as a
  variant. **Load state** restores it.

```
src/core/     palette, colour science, adjustments, cell fitting, dither, packing
src/ui/       schema-driven controls, state, prefs, loader, export plumbing
src/workers/  conversion off the main thread
bench/        invariant tests, UI smoke test, end-to-end render
```

`npm run check` verifies the invariants that actually matter: `.scr` is 6912 bytes, every
attribute's ink/paper sit in the same palette half, no cell uses a third colour, and
`toScr`→`fromScr` round-trips losslessly. The UI half of it also asserts the layout order
and that both kinds of preference persist.

## Dev server

The port is pinned to **6912** in `vite.config.ts` with `strictPort`, so this project never
takes Vite's shared default 5173 and a clash fails loudly instead of drifting.

## References

- [Screen memory layout](http://breakintoprogram.co.uk/hardware/computers/zx-spectrum/screen-memory-layout)
- [Attribute clash](https://en.wikipedia.org/wiki/Attribute_clash) · [graphic modes](https://en.wikipedia.org/wiki/ZX_Spectrum_graphic_modes)
- [Ordered dithering](https://en.wikipedia.org/wiki/Ordered_dithering) · [error diffusion](https://en.wikipedia.org/wiki/Error_diffusion)
- [img2spec](https://github.com/jarikomppa/img2spec) / [Spectrumizer](https://solhsa.com/spectrumizer) — interactive modifier stacks
- [puregrain cell scoring](https://github.com/roman-mkh/puregrain/blob/master/docs/machine-screens/README.md) — segment-distance scoring
- [ZX Spectrum raytracer](https://gabrielgambetta.com/zx-raytracer.html) — most-frequent-two-colours and Bayer per cell
