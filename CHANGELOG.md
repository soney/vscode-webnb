# Changelog

All notable changes to the Web Notebook extension are documented here.

## 1.0.3 — 2026-08-02

- **Links between notebooks.** `[text](other.webnb#section)` now navigates
  straight to a section of another notebook instead of opening it as plain
  text, in both markdown cells and the built-in markdown preview.
- **View solution.** Code cells with a `+solution` addon get a "View solution"
  button that swaps in the reference answer on demand.
- **Reset code.** Learners can restore a single code cell to its starting
  state after experimenting.
- **Restore Notebook to Starter State.** A toolbar command that resets an
  entire notebook — code, answers, and outputs — back to how it shipped.
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
- Internal: split the codebase into shared modules with one source of truth
  per concern, and added unit tests, a renderer regression harness, browser
  specs, and CI.

## 1.0.0 — 2026-04-19

- **Multiple choice questions** with per-item and question-level feedback.
- **Automatic running** of cells via `autorun` and `runonstart`.
- Smart quotes and dashes in markdown cells.

## 0.0.1 — 2025-03-05

- Initial release: `.webnb` notebooks with runnable HTML, CSS, JavaScript,
  Node, and React cells, addon blocks, and assertion-based tests.
