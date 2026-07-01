# Web Notebook Preview

A browser-based preview/editor for `.webnb` notebooks. It reuses the extension's
**exact** renderer (`src/client/render.ts`) and parser (`src/extension/markdownParser.ts`),
so what you see here matches what VS Code shows — but it runs as a plain web app
with instant feedback.

## What it does

- **Live preview from disk.** Edit a `.webnb` file in your normal editor and the
  open notebook re-renders the moment you save. Images update too.
- **Fully interactive.** Run cells, take MCQs, run tests, drive the simulated
  terminal — the same renderer the notebook controller uses.
- **A fake filesystem.** Edits you make *in the browser* (cell code, plus the
  virtual exercise files that `{external}` / `+files` checks look for) are kept in
  an in-browser overlay saved to `localStorage`. **They are never written to
  disk.** Disk is read-only; your real files are safe.

## Run it

From the extension repo root:

```bash
npm install        # first time only (adds vite + codemirror dev deps)
npm run preview
```

Then open the printed URL (default http://localhost:5173).

## Point it at a workspace

The preview needs to know which folder holds your notebooks (the same folder you
would open in VS Code). Resolution order:

1. `WEBNB_WORKSPACE=/path/to/workspace npm run preview`
2. `preview/webnb.config.json` → `{ "workspace": "/path/to/workspace" }`

`webnb.config.json` is git-ignored because the path is machine-specific.

## How browser edits work

| You edit…                         | Stored in            | Touches disk? |
| --------------------------------- | -------------------- | ------------- |
| A `.webnb` file in your editor    | disk                 | yes (by you)  |
| A cell's code in the browser      | `localStorage` scratch | no          |
| A virtual file (Virtual Files panel) | `localStorage` overlay | no        |

- A cell with a browser edit shows an **"edited in browser"** badge and a
  **Reset to disk** button.
- The **Virtual Files** panel (top-right) is where you create/edit the files an
  exercise checklist expects. Reads fall through to disk, so a `{external}` check
  for a file that already exists on disk still sees it; anything you create or
  change there shadows disk without modifying it.

## Notes

- This is a **dev-only** tool. The dev server (a Vite plugin) provides the file
  API and live-reload; there is no production build.
- It is intentionally excluded from the packaged extension (`.vscodeignore`).

## Known limitations

- **Deterministic MCQ shuffle order may differ from VS Code.** The renderer seeds
  deterministic shuffling with the cell's URI; VS Code uses an internal
  `vscode-notebook-cell:` URI that a standalone web app can't reproduce. The order
  is still stable across reloads here — it just may not be byte-identical to the
  order a student sees in VS Code. Feedback/correctness logic is unaffected.
- Markup cells are rendered with `marked` (the same engine the renderer uses for
  inline markdown), which is very close to but not identical to VS Code's built-in
  markdown rendering for edge-case extensions.
