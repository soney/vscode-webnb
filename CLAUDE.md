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
  the mime constant, which addons the renderer may write), `addons.ts`
  (addon-type and language predicates), `checklist.ts` (the
  `kind: path | value | label` grammar), `filePaths.ts` (which workspace files a
  cell references, path normalization/resolution), `imageSize.ts` (the
  `![alt](url =WxH)` syntax), `indentation.ts` (list-item indentation of cells),
  `outputHeight.ts` (the `height=` attribute), `notebookLinks.ts` (link grammar,
  VS Code-exact heading slugs, the link-handler handshake).
- **`src/extension/`** — extension host. `webnbProvider.ts` is the kernel
  (controller lifecycle, cell execution → JSON output; background runs never
  take focus); one concern per file around it: `autorunScheduler.ts`,
  `walkthroughHighlighter.ts`, `workspaceSnapshots.ts` +
  `workspaceContainment.ts` (paths and symlinks stay inside the workspace),
  `cellStructureLock.ts`, `defaultCapture.ts` (captures `+default` on first
  edit; nothing else writes it), `markdownLock.ts`, `readOnlyMode.ts`,
  `restoreNotebook.ts`, `inputCollapser.ts` (hidecode and widget cells),
  `reopenAsNotebook.ts` (a `.webnb` opened as text at startup),
  `serializer.ts`/`markdownParser.ts` (the .webnb ⇄ notebook round-trip:
  byte-identical, malformed blocks kept as text), `notebookUris.ts`,
  `notebookLinkNavigator.ts`, `log.ts` (LogOutputChannel "Web Notebook";
  execution traces log at Trace level).
- **`src/client/`** — the notebook renderer (webview). `render.ts` dispatches
  per cell language to `mcq.ts`, `checks.ts`, `terminal.ts`, `walkthrough.ts` /
  `walkthroughRender.ts`, the js/node/react runtime (`runtime.ts` shims), with
  `cellActions.ts` (View solution / Reset code strip), `consoleCapture.ts`,
  `feedback.ts`, `markdown.ts` + `markedImageSize.ts`, `syntaxHighlight.ts`,
  `lite-cy.ts` (the assertion/grading engine), `cellGlobals.ts` (the
  cell-scoped `document`/`window`, tracked timers and listeners, async error
  routing) and `loopGuard.ts` (runaway-loop protection spliced into cell code)
  underneath. `mountRenderer.ts` is the DOM contract both hosts mount through;
  it shows render errors inside the output.
- **`preview/`** — a vite dev harness that hosts the *same* `render()` and the
  same `src/shared` discovery logic, so anything cell-rendering related can be
  observed in a plain browser (`npm run preview`, needs `WEBNB_WORKSPACE`).
- **`src/markdownItPlugin/`** — extends VS Code's builtin markdown renderer:
  the image-size syntax (parser shared via `src/shared/imageSize.ts`) and
  `notebookLinkClicks.ts`, which takes `[x](other.webnb#section)` clicks away
  from VS Code and hands them to `extension/notebookLinkNavigator.ts`
  (grammar and slugs shared via `src/shared/notebookLinks.ts`). That renderer
  runs in every notebook type's webview, so it intercepts nothing until the
  host answers its hello with "this is a Web Notebook".
- **`preview-extension/`** — a separate, unpublished extension: a live preview
  beside a `.webnb` opened as text, built on the same parser and `render()`.

## The eval-scope contract (read before touching render.ts)

`render()` deliberately exposes its local bindings to notebook and addon code
through a direct `eval()` in `evalCellCode` (html/css/external addons, plain-JS
cells) and a `new Function` sandbox (node/react/module cells). The names in
scope — `console`, `document`, `window`, `assert`, `assertRule`, `wrap`,
`check`, `checklist`, `file`, `createFileResult`, `files`, `source`, `cy`, `sy`,
`defaultSource`, `terminal`, `renderReact`, `React`, `ReactDOM`, `pathModule`,
the timer functions, … — are API for existing notebooks, invisible to the type
checker. `document` and `window` are the cell-scoped stand-ins from
`cellGlobals.ts`; `__webnbNow` / `__webnbLoopFail` must stay in scope for the
loop guards. Two traps:

- webpack rewrites **import bindings**, so an imported name is NOT eval-visible;
  it must be re-bound as a local `const` inside `render()` (see `pathModule`).
- renaming or moving any of these locals silently breaks notebooks at runtime.

When in doubt, run the harness (below) across every cell language.

## Building and verifying

- `npm run compile-dev` / `npm run compile` — webpack, all four targets, with
  type-checking. `npm run lint`.
- `npm run test:unit` — mocha over the pure modules (`src/test/unit`) and the
  extension-host modules (`src/test/host`, `src/test/extension.test.ts`),
  compiled via `tsc -p src/test`; host code runs against the `vscode` stub in
  `src/test/host/vscodeStub.ts`, loaded by the require hook in
  `src/test/setup/vscodeHook.ts`.
- `npm run test:harness` — renders every cell of `samplenotebooks/` in the
  preview harness and diffs against `tests/harness/goldens/`. This is the
  renderer regression suite; after an intentional rendering change run
  `npm run test:harness:update` and review the golden diff.
- `npm run verify:notebooks -- /path/to/course` (or
  `node scripts/verify-notebooks.js` from inside a course repo) — structural
  verification of an arbitrary workspace's notebooks through the same preview
  harness: parses/loads, renders every code cell (a render error fails), no
  uncaught errors. `--solutions` swaps each `+solution` in for its cell (the
  preview's `?solutions` mode) and fails on any error from a cell that has one:
  the check that every reference answer passes its own tests in the real
  renderer. `--baseline` gives a course repo its own committed golden workflow.
- `npm run check:vsix` — packages into a temp folder and fails on any file
  that should not ship, a missing entry point, or a VSIX over 2 MiB.
- `npm run test:browser` — lite-cy specs in real Chromium (needs
  `getComputedStyle`), imported through vite's transform pipeline; each spec's
  host sits in a shadow root, as a real cell output does.
- Extension-host behavior (kernel selection, autorun, message routing) is NOT
  covered by the preview harness (`@vscode/test-web` checks online for the
  newest build at each launch, so it needs network). Drive the real workbench:
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
