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
- **Light and dark themes.** The ◐ / ☀ / ☾ picker in the header switches between
  following the system theme, always-light, and always-dark. The choice is saved
  to `localStorage`, and `auto` keeps tracking the OS while it is selected.

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

## Solutions mode

Open the preview with `?solutions` in the URL (for example
`http://localhost:5173/?solutions`) and every HTML, CSS, JavaScript, Node, and
React cell that has a `+solution` starts from that solution instead of its
source, as if a learner had solved every exercise. A "Solutions mode" chip in
the header shows it is on; browser edits made in this mode are stored apart
from normal-mode edits. `scripts/verify-notebooks.js --solutions` checks a whole
workspace this way.

## How browser edits work

| You edit…                         | Stored in            | Touches disk? |
| --------------------------------- | -------------------- | ------------- |
| A `.webnb` file in your editor    | disk                 | yes (by you)  |
| A cell's code in the browser      | `localStorage` scratch | no          |
| A virtual file (Virtual Files panel) | `localStorage` overlay | no        |

- A cell with a browser edit shows an **"edited in browser"** badge and a
  **Reset to disk** button.
- Starter code follows the extension's rule. A code cell with no `+default`
  gets one on its first edit: the text it had when it opened, even if empty
  (VS Code writes it into the file; here it is kept with the browser edits).
  An existing `+default`, empty or not, is never changed, and running a cell
  never creates one. The renderer's **Reset code** puts the starter back and
  re-runs; a cell with no starter ignores it. **Reset to disk** also drops a
  captured starter.
- The **Virtual Files** panel (top-right) is where you create/edit the files an
  exercise checklist expects. Reads fall through to disk, so a `{external}` check
  for a file that already exists on disk still sees it; anything you create or
  change there shadows disk without modifying it.

## Notes

- This is a **dev-only** tool. The dev server (a Vite plugin) provides the file
  API and live-reload; there is no production build.
- It is intentionally excluded from the packaged extension (`.vscodeignore`).
- The dev server binds `localhost`. Its file API only reads inside the
  workspace (symlinks are resolved first) and never serves a path with a
  segment starting with `.`, so `.env`, `.git/`, and key files stay private
  even if you start it with `--host`. The flip side: a notebook file check of
  a dotfile reports an error here, although VS Code would read the file.

## Known limitations

- **Deterministic MCQ shuffle order may differ from VS Code.** The renderer seeds
  deterministic shuffling with the cell's URI; VS Code uses an internal
  `vscode-notebook-cell:` URI that a standalone web app can't reproduce. The order
  is still stable across reloads here — it just may not be byte-identical to the
  order a student sees in VS Code. Feedback/correctness logic is unaffected.
- Markup cells are rendered with `marked` (the same engine the renderer uses for
  inline markdown), which is very close to but not identical to VS Code's built-in
  markdown rendering for edge-case extensions. Their code fences are highlighted
  with highlight.js via `src/client/syntaxHighlight.ts`, so the token colors match
  the renderer's rather than whatever theme VS Code's markdown engine would apply.
