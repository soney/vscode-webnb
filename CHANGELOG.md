# Changelog

All notable changes to the Web Notebook extension are documented here.

## 1.1.0 - Unreleased

### Grading

- **Check results no longer hide earlier ones.** `check.*().run()` and
  `file().run()` add their result to the others instead of replacing them, so a
  passing check can no longer make a wrong answer look all green.
- **Tests in HTML and CSS cells see the cell.** `document` in test code finds the
  cell's own elements, and a test that throws reports an error instead of
  silently stopping; when an earlier check already failed, the cell says the
  remaining checks could not run.
- `assert()` no longer counts an `<html>`, `<head>` or `<body>` the browser
  invented for a cell that never wrote one.
- No more accidental passes: an unknown assertion name fails (with a list of the
  supported ones), an action on a selector that matched nothing fails, a
  selection with no assertion requires a match, and element assertions on plain
  values (or value assertions on elements) fail instead of passing.
- New assertions: `contain.text`, `have.value`, `be.visible`, `be.checked`,
  `be.disabled`, `include`, `be.true`, `be.false`, `be.null`, `be.undefined`,
  and the aliases `eq`, `eql`, `deep.equal`, `include.text`, `have.lengthOf`.
  `wrap(element)` takes element assertions.
- `have.text` compares text as a reader sees it (whitespace runs collapse, the
  ends are trimmed), so reformatted HTML still passes.
- SVG elements support `have.attr`, `have.class`, `have.css` and `click()`.
- `assertRule()` reads only the cell's own CSS, and combines repeated rules for
  one selector the way the cascade does.
- `contains()` searches within the chain, `type()` updates React controlled
  inputs, and `be.a('function')` accepts async and generator functions.
- Failure messages show values as code, so typography no longer alters them.

### Running code

- **Each cell sees a page of its own.** `document` is scoped to the cell's
  output in every cell type, `document.createElement` works everywhere, and
  `window.document === document`.
- Timers and `window`/`document` listeners stop when a cell runs again.
- Errors thrown later -- from a timer, a listener, a rejected promise, or a React
  component -- appear in the cell's console as `Uncaught ...` instead of
  vanishing.
- A loop that runs for more than 5 seconds is stopped with an error instead of
  freezing the notebook.
- React renders synchronously (`renderReact` and `ReactDOM.createRoot`), and a
  click in a test applies its state update before the next assertion, so React
  tests no longer need `setTimeout`. Roots unmount when the cell runs again.
- A `+id=` reference to a JavaScript cell runs before the cell's code, like an
  earlier `<script>` tag.
- Node and React cells may declare names the helpers use (`const file = ...`).
- The console prints elements as markup and circular objects as `[Circular]`,
  and stops growing after 1000 messages.
- Terminal history is saved in the notebook (`+history`), so a terminal
  checklist keeps its progress across reloads.
- An output that cannot be drawn says so inside the output.

### Notebook files

- **Saving no longer rewrites what the author wrote**: fence attributes (their
  order and any unknown words), the `{jsx}` spelling, CRLF line endings and a
  byte order mark all survive a save.
- A cell may contain lines starting with ```` ``` ````; the file is saved with a
  longer fence. Fences follow CommonMark's closing rule.
- A malformed block (an addon with no cell above it, a `+id=` naming no earlier
  cell, a fence that never closes) is shown as text, logged, and saved back
  unchanged, instead of making the notebook impossible to open.
- Running cells no longer marks the notebook as modified.
- `+default` is captured on the first edit even when the starter is empty, and
  nothing else ever writes it, so Reset code and Restore Notebook bring back the
  real starter (never a first attempt) and work for exercises that shipped
  empty.

### In the editor

- **Checklists that re-check themselves no longer steal keyboard focus** from
  the file a learner is typing in, and they resume when a hidden notebook is
  shown again.
- Editing an autorun cell re-runs only that cell, so multiple choice questions
  no longer reshuffle while you type.
- The cell structure lock accepts reloads from disk and File: Revert, undoes
  Split Cell and Join whole, and holds against a held Delete key; the markdown
  lock holds against Replace All.
- `hidecode` collapses the code; widget cells collapse once per session, and a
  cell the reader expands stays expanded.
- Restore Notebook has an editor title button where the notebook toolbar is
  hidden (as in the course lab), asks in a modal dialog, clears terminal history
  too, and re-runs the cells that run on their own.
- A `.webnb` opened as text at startup (a lab launcher) reopens as a notebook
  without closing any other editor; one reopened as text later stays text. The
  extension no longer activates in every window at startup.
- `webnb.readOnly` sets `files.readonlyInclude` in the same settings scope and
  removes only what it added.
- Links between notebooks are handled only in Web Notebooks (links in other
  notebook types behave normally) and never inside a learner's own page; they
  cannot leave the workspace. Section anchors match VS Code's for headings with
  code spans, HTML, images and repeated headings.
- File checks and walkthroughs refuse symbolic links that lead outside the
  workspace; with no folder open, their paths resolve next to the notebook.
- Removed the unused "Focus on a single file" command.

### Accessibility

- Test results and checklist updates are announced to screen readers; multiple
  choice options are grouped under their question; right and wrong answers are
  marked by more than color; the View solution and Show Answer buttons report
  whether they are open.
- The simulated terminal uses the editor's theme colors.

### Internal

- Host-side unit tests (with a `vscode` stub) run in `npm run test:unit`; lint
  fails on warnings; CI also checks the preview extension and the VSIX contents;
  `scripts/verify-notebooks.js` fails on render errors and gained `--solutions`.

## 1.0.3 — 2026-08-02

- **Links between notebooks.** `[text](other.webnb#section)` now navigates
  straight to a section of another notebook instead of opening it as plain
  text, in both markdown cells and the built-in markdown preview.
- **View solution.** Code cells with a `+solution` addon get a "View solution"
  button that shows the reference answer beside the cell on demand.
- **Reset code.** Learners can restore a single code cell to its starting
  state after experimenting.
- **Restore Notebook to Starter State.** A toolbar command that resets an
  entire notebook — code, answers, and outputs — back to how it shipped.
- **`hidecode`** shows only a cell's output, running it on its own; **`height=`**
  sets a cell's output pane height.
- **New setting `webnb.lockMarkdown`** keeps prose cells from being edited
  while leaving code cells editable and runnable.
- **New setting `webnb.allowRevealingSolutions`** turns the "View solution"
  and "Show Answer" buttons off entirely, for use during an assessment.

## 1.0.2 — 2026-07-28

- **Code walkthrough cells.** `{walkthrough}` cells step through real
  workspace files with per-step line ranges, region markers, and annotations.
- **Syntax highlighting** in rendered code cells and walkthroughs.
- Fixed React cells by compiling with Babel's classic JSX runtime.
- Fixed indented `.webnb` code samples being parsed with their leading
  whitespace.
- Fixed opening `.txt` files referenced by a notebook.
- New settings `webnb.lockCellStructure` and `webnb.readOnly`; new assertions
  `be.a` / `be.an`, `have.property`, deep `equal`, and a `not.` form of every
  assertion.
- `workspace:` paths for checks, and `+default` starter code.
- Internal: split the codebase into shared modules with one source of truth
  per concern, and added unit tests, a renderer regression harness, browser
  specs, and CI.

## 1.0.0 — 2026-04-19

- **Multiple choice questions** with per-item and question-level feedback.
- **Automatic running** of cells via `autorun` and `runonstart`.
- Smart quotes and dashes in the text the notebook draws itself (questions,
  feedback, walkthrough notes).

## 0.0.1 — 2025-03-05

- Initial release: `.webnb` notebooks with runnable HTML, CSS, JavaScript,
  Node, and React cells, addon blocks, and assertion-based tests.
- External checks of workspace files, and the simulated terminal.
