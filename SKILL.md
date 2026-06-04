**Carousel Image Generation Skill**

- **Purpose:** Create Instagram/TikTok-style carousel images from a plan, matching a tight visual style (large stacked title, gold textured text, darkened background, watermark, page indicator).
- **Entry point(s):**
  - `src/generate-carousel-exact.js` — produce a single test image following the example.
  - `src/render-carousel-layout-pure.js` — general layout renderer for multi-slide carousel mockups.

- **Steps performed:**
  1. Select or generate a background image for the slide (cover/crop to target aspect).
 2. Apply a dark overlay to increase contrast for text.
 3. Compute safe margins (default 6% horizontal, 8% bottom) and text area bounds.
 4. Render stacked uppercase title lines with thick black stroke and warm-gold fill. Use multiple offset draws to simulate stroke since `pureimage` has limited stroke API.
 5. Draw watermark (circle + `TWH`) and page indicator (`1/7`) at top-right.
 6. Export to JPEG at target size.

- **Config / Constants**
  - Default test size: `1080 x 1350` (portrait). Adjust `targetW` / `targetH` in scripts.
  - Default margins: `marginX = 6%`, `bottomMargin = 8%`.
  - Default gold colors: base `#d48b00`, highlight `rgba(255,196,64,0.85)`.

- **Fonts**
  - The scripts attempt to register system TTFs (Segoe UI / Impact / Georgia / Arial). For pixel-perfect typography, supply a TTF and update `fontPath` or place it under `assets/fonts/` and register it in the script.

- **How to run**
  - Generate background images (existing pipeline) or use `generated/images/*`.
  - Run single-test generator:

```bash
node src/generate-carousel-exact.js
```

  - Run multi-slide layout renderer (creates final mockups from `carousel-demo-layout.json`):

```bash
node src/render-carousel-layout-pure.js
```

- **Repro / Tuning**
  - To change size, edit `targetW` / `targetH` in the script.
  - To change margins, adjust `marginX` percent.
  - To use a custom gold texture, provide a texture image under `assets/` and modify the fill step to composite the texture clipped to text (requires more advanced compositing).

- **Quality checks performed**
  - Ensures text block stays within horizontal margins and vertical text area.
  - Exports a manifest JSON with output paths and any errors encountered.

If you want an exact 1:1 pixel match to an uploaded sample, upload the sample TTF/font and/or texture image and I will iterate until it is visually identical.
