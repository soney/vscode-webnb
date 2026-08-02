# Web Notebook Source Preview

Edit a `.webnb` file as Markdown, with the rendered notebook live beside it.

A `.webnb` normally opens as a notebook, which is the right editor for reading
and for running cells but the wrong one for authoring: you cannot see the
document's structure, and the parts that are not cells (indentation, blank
lines, addon blocks) are invisible. This extension adds the other half: the
source in a text editor, the notebook rendered next to it, updating as you type.

The preview is **not** a lookalike. It parses with the Web Notebook extension's
own `parseMarkdown` and renders each cell by calling the same `render()` the
notebook editor calls, so what you see is what a reader sees.

## Commands

| Command | Shortcut |
| --- | --- |
| `Web Notebook Preview: Open Live Preview to the Side` | `Ctrl+K V` / `Cmd+K V` in a `.webnb` editor |
| `Web Notebook Preview: Open as Text (Source)` | `Ctrl+K Ctrl+E` / `Cmd+K Cmd+E` in a notebook |
| `Web Notebook Preview: Open as Notebook` | |
| `Web Notebook Preview: Refresh Preview` | |

Opening the preview from a notebook editor replaces it with the Markdown source
so the two sit side by side; set `webnbPreview.openSourceOnPreview` to `false`
to keep the notebook editor and put the preview beside that instead.

## What works in the preview

- **Live.** Cells re-render as you type. Only cells whose text actually changed
  are rebuilt, so outputs, terminals and answers elsewhere in the file survive.
- **Interactive.** Multiple choice, file checklists, walkthroughs and tests run
  for real, against the real workspace. Run buttons work; once a cell has been
  run it keeps re-running as you edit it.
- **Scroll-synced.** The preview follows the editor and the editor follows the
  preview. Double-click a cell, or use **Go to source**, to jump to its line.
- **Follows the editor.** Switch to another `.webnb` source and the preview
  moves with you: no second panel, no clicking the preview button again. A
  notebook that already has its own preview keeps it, so two previews open side
  by side stay put.
- **Read-only.** Cell code is shown, not edited: the text editor beside the
  preview is the only thing that writes to the file. Answers picked in the
  preview live in the panel's own state and are never written back.
- **Broken states stay useful.** A half-typed notebook that does not parse (an
  addon block before its code block) keeps the last good render on screen and
  shows the parse error above it, instead of blanking.

## Settings

- `webnbPreview.scrollSync` (default `true`) -- keep the preview and the source
  editor scrolled together.
- `webnbPreview.autoRunAll` (default `false`) -- run every code cell on render,
  not just `autorun`/`runonstart` cells and the self-rendering widgets.
- `webnbPreview.followActiveEditor` (default `true`) -- move an open preview to
  whichever `.webnb` source you switch to. Turn it off to pin each preview to
  the notebook it was opened for.
- `webnbPreview.openSourceOnPreview` (default `true`) -- see above.

Solutions follow the notebook extension's own `webnb.allowRevealingSolutions`,
so the two views never disagree about what a reader can reveal.

## Building

The build reaches into the sibling `vscode-webnb` checkout for the renderer, the
parser and the shared modules, and resolves the renderer's dependencies
(`react`, `marked`, `@xterm/xterm`, ...) from that package's `node_modules`.
Nothing is copied, so there is no second version of the renderer to keep in
sync -- but that checkout must be installed:

```bash
npm install --prefix ../vscode-webnb
```

Then, from this directory:

```bash
npm install && npm run check
```

`npm run check` type-checks, runs the tests, and produces `out/extension.js` and
`out/webview.js`. `npm run watch` rebuilds on change. `WEBNB_DIR` overrides where
the notebook extension's sources are found (for a sibling dev clone).

To use it in your own VS Code or code-server:

```bash
npm run gen-vsix
```

## Notes for future work

**It does not patch the notebook extension.** The draft this was ported from
added `startLine`/`endLine` to `markdownParser.ts`; this version recovers the
same information from the parser's existing output instead (`cellSpans.ts`), so
`vscode-webnb` stays untouched and can be updated underneath this extension.
`test/cellSpans.test.mjs` checks that inference against every notebook in the
course (8675 cells) and the extension's own samples, asserting that each span
really does contain its cell's body -- so a future parser change that moves a
cell boundary fails a test rather than silently mis-scrolling the preview.

**The webview bundle is never minified.** `render()` deliberately exposes its
local bindings to notebook code through direct `eval()`; renaming any of them
breaks author cells at runtime with no compile-time signal. See the note in
`esbuild.mjs`.

**Snapshots are duplicated plumbing, not duplicated rules.**
`documentSnapshots.ts` mirrors the notebook's `workspaceSnapshots.ts` because
that module's entry points take a `vscode.NotebookCell` and a text preview has
none. Every rule it applies -- which paths a cell requests, how they resolve,
the size cap -- comes from `@webnb/shared`.
