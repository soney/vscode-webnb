# vscode-webnb

A VS Code notebook extension for `.webnb` files — Markdown documents with
executable tutorial cells (HTML/CSS/JS/React/Node simulations, multiple-choice
questions, workspace-file checklists, code walkthroughs). See SYNTAX.md for
the authoring format.

## Architecture

Four build targets share one source tree; `src/shared/` is the single source
of truth for everything that must not drift between them:

- **`src/shared/`** — dependency-free (no vscode, no DOM). `protocol.ts` (the
  kernel→renderer output payload, the renderer→kernel message union + guard,
  the mime constant), `addons.ts` (addon-type and language predicates),
  `checklist.ts` (the `kind: path | value | label` grammar), `filePaths.ts`
  (which workspace files a cell references, path normalization/resolution),
  `imageSize.ts` (the `![alt](url =WxH)` syntax).
- **`src/extension/`** — extension host. `webnbProvider.ts` is the kernel
  (controller lifecycle, cell execution → JSON output); one concern per file
  around it: `autorunScheduler.ts`, `walkthroughHighlighter.ts`,
  `workspaceSnapshots.ts`, `cellStructureLock.ts`, `defaultCapture.ts`,
  `markdownLock.ts`, `readOnlyMode.ts`, `restoreNotebook.ts`,
  `serializer.ts`/`markdownParser.ts` (the .webnb ⇄ notebook round-trip),
  `notebookUris.ts`, `notebookLinkNavigator.ts`, `log.ts` (LogOutputChannel
  "Web Notebook"; execution traces log at Trace level).
- **`src/client/`** — the notebook renderer (webview). `render.ts` dispatches
  per cell language to `mcq.ts`, `checks.ts`, `terminal.ts`,
  `walkthroughRender.ts`, the js/node/react runtime (`runtime.ts` shims), with
  `cellActions.ts` (View solution / Reset code strip), `consoleCapture.ts`,
  `feedback.ts`, `markdown.ts`, `lite-cy.ts` (the assertion/grading engine)
  underneath. `mountRenderer.ts` is the DOM contract
  both hosts mount through.
- **`preview/`** — a vite dev harness that hosts the *same* `render()` and the
  same `src/shared` discovery logic, so anything cell-rendering related can be
  observed in a plain browser (`npm run preview`, needs `WEBNB_WORKSPACE`).
- **`src/markdownItPlugin/`** — extends VS Code's builtin markdown renderer:
  the image-size syntax (parser shared via `src/shared/imageSize.ts`) and
  `notebookLinkClicks.ts`, which takes `[x](other.webnb#section)` clicks away
  from VS Code and hands them to `extension/notebookLinkNavigator.ts`
  (grammar and slugs shared via `src/shared/notebookLinks.ts`).

## The eval-scope contract (read before touching render.ts)

`render()` deliberately exposes its local bindings to notebook and addon code
through bare `eval()` calls (html/css/external addons, plain-JS cells) and a
`new Function` sandbox (node/react/module cells). The names in scope —
`console`, `document`, `assert`, `assertRule`, `wrap`, `check`, `checklist`,
`file`, `createFileResult`, `files`, `source`, `cy`, `sy`, `defaultSource`,
`terminal`, `renderReact`, `pathModule`, … — are API for existing notebooks,
invisible to the type checker. Two traps:

- webpack rewrites **import bindings**, so an imported name is NOT eval-visible;
  it must be re-bound as a local `const` inside `render()` (see `pathModule`).
- renaming or moving any of these locals silently breaks notebooks at runtime.

When in doubt, run the harness (below) across every cell language.

## Building and verifying

- `npm run compile-dev` / `npm run compile` — webpack, all four targets, with
  type-checking. `npm run lint`.
- `npm run test:unit` — mocha over the pure modules (compiled via
  `tsc -p src/test`).
- `npm run test:harness` — renders every cell of `samplenotebooks/` in the
  preview harness and diffs against `tests/harness/goldens/`. This is the
  renderer regression suite; after an intentional rendering change run
  `npm run test:harness:update` and review the golden diff.
- `npm run verify:notebooks -- /path/to/course` (or
  `node scripts/verify-notebooks.js` from inside a course repo) — structural
  verification of an arbitrary workspace's notebooks through the same preview
  harness: parses/loads, renders, no uncaught errors. `--baseline` gives a
  course repo its own committed golden workflow.
- `npm run test:browser` — lite-cy specs in real Chromium (needs
  `getComputedStyle`), imported through vite's transform pipeline.
- Extension-host behavior (kernel selection, autorun, message routing) is NOT
  covered by the preview harness. Drive the real workbench:
  `node scripts/vscode-test-web.js samplenotebooks/sample.webnb --browser none --port 3066`
  and connect via `http://localhost:3066` (literally `localhost`). Outputs
  live in webview iframes AND shadow roots — read `shadowRoot.textContent`,
  not `innerText`. Clicking the toolbar's **Run All** exercises the whole
  kernel path deterministically. When checking for regressions, run the same
  probe against a pre-change build first (control) and diff the profiles.
  `tests/workbench/notebook-links.js` is one such probe, kept because
  cross-notebook navigation exists only in the workbench: start the server on
  `samplenotebooks/links.webnb`, then run it (see its header).

## Conventions

- Behavior-preserving by default: checklist grammar, message shapes, and
  error strings are load-bearing (the preview harness's fidelity depends on
  them); change them in `src/shared/` only, never in a single consumer.
- One concern per file in `src/extension/`, following
  `cellStructureLock.ts`/`readOnlyMode.ts` (a focused `vscode.Disposable`).
- Duration values: checklist `interval:` defaults bare numbers to
  milliseconds; walkthrough `watch:` defaults to seconds. Docs tell authors to
  always write units — do not "fix" one to match the other.
- SYNTAX.md is standalone (other projects link to it): no repo-relative links
  or references to `samplenotebooks/`, README.md, or other repo files. Repo
  pointers (working examples, dev docs) belong in README.md.
