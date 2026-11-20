# contributing to webrot

thanks for wanting to help improve webrot! everything here runs locally in the browser with astro, react, and typescript.

## getting started

```bash
pnpm install
pnpm dev      # starts local dev server at http://localhost:4321
pnpm check    # runs astro check and tsc --noEmit
pnpm build    # builds static output into dist/
```

## project layout & style

- **filenames**: use camelCase for files (`webrotApp.tsx`, `rotWorkspace.tsx`, `formatRots.ts`, `byteEngines.ts`, `baseLayout.astro`).
- **ui copy & titles**: keep all ui text, labels, headings, toasts, and notices all-lowercase (never alter user file names).
- **comments**: only add comments that explain *how* or *why* non-obvious logic works, and write them in all-lowercase. skip decorative banners or comments that just restate code.
- **icons & fonts**: use filled `material symbols outlined` via `<Icon name="..." />` from `@/design`, with `google sans flex` (`ROND 100` for headings/controls) and `cascadia code` for monospace values.
- **privacy**: never add external uploads, tracking, or server dependencies. every format parser, compressor, and databender must run 100% client-side.

## how to add a new format handler

1. implement a format-aware rotter in `src/lib/formatRots.ts` that keeps the file's header / container structure valid when `settings.protectHeaders` is enabled (and falls back cleanly if a file is malformed).
2. add the handler to `FORMAT_HANDLERS` in `src/lib/formatRots.ts` before the universal raw-binary fallback:

```ts
{
  id: "my-format",
  label: "my format (.myf)",
  category: "daw", // "image" | "audio" | "daw" | "video" | "3d" | "document" | "text" | "binary"
  extensions: ["myf"],
  strategy: "myf payload bend",
  description: "preserves the myf header while databending frame payloads.",
  detect: (buf, ext) => ext === "myf" || (buf.length >= 4 && buf[0] === 0x4d && buf[1] === 0x59),
  rot: async (input, settings) => {
    const out = new Uint8Array(input);
    const { mutated } = mutateByteRange(out, 64, out.length, settings);
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "myf payload bend",
      summary: `${mutated} payload bytes bent (64b header safe)`,
    };
  },
}
```

3. once added, detection, batch rerolling, and the formats modal (`src/components/formatsModal.tsx`) pick it up automatically.
4. always seed randomness from `mulberry32(settings.seed)` so identical seeds reproduce the exact same rotted output.

## how to add a new rot mode

1. add the mode union member to `RotMode` and metadata to `ROT_MODES` in `src/lib/types.ts`.
2. implement the byte transformation branch in `mutateByteRange` inside `src/lib/byteEngines.ts` (respecting `avoidBytes`, `blockAlign`, and `amount`).
3. verify the mode works cleanly on both raw byte buffers (e.g. `.bmp`, `.wav`) and compressed payloads (e.g. `.jpg`, `.mp3`).

## ai-assisted contribution guidelines

ai coding tools are welcome as long as you stay responsible for every line you submit:

- **disclose ai usage**: briefly mention in your pr description if ai tools helped write or refactor the change.
- **review and understand your diff**: don't open drive-by prs with code you haven't read. remove leftover comments, unused helpers, or unrelated edits.
- **test with real files**: verify that rotted output actually opens or plays in real apps (preview/browser for images & audio, fl studio / daw for project files) — don't rely on type checks alone.
- **match the codebase**: follow camelCase filenames, lowercase ui copy, minimal intentional animations, and zero external dependencies where native browser apis work.
- **keep prs focused**: one format handler, rot mode, or bug fix per pull request.

## pull request checklist

- [ ] `pnpm check` passes with 0 errors and 0 warnings
- [ ] `pnpm build` succeeds cleanly
- [ ] tested in the browser with real files (rot, reroll, preview, and download / zip export)
- [ ] deterministic seeds produce identical output across runs
- [ ] no unrelated formatting changes or leftover debug code
- [ ] new ui text and explanatory comments are lowercase
