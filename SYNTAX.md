# Web Notebook Syntax

A Web Notebook (`.webnb`) file is a Markdown document with executable tutorial cells. Prose between cells is ordinary Markdown; a fenced code block whose language is wrapped in braces — ` ```{html} ` — becomes a learner-editable cell, and fenced blocks starting with `+` attach addons (fixtures, styles, tests, references) to the cell above them.

This file is the complete authoring reference. Working examples live in `samplenotebooks/`. For building, running, and developing the extension itself, see [README.md](README.md).

## Contents

- [Basic Cell Format](#basic-cell-format)
- [Markdown Images (Sizing)](#markdown-images-sizing)
- [JavaScript Cells](#javascript-cells)
- [Node Cells](#node-cells)
- [Module Syntax (`import` / `export`)](#module-syntax-import--export)
- [React Cells](#react-cells)
- [Addon Blocks](#addon-blocks)
- [Referencing Other Cells](#referencing-other-cells)
- [Tests](#tests)
- [Automatic Running](#automatic-running)
- [Multiple Choice Questions](#multiple-choice-questions)
- [External Checks](#external-checks)
- [Code Walkthroughs](#code-walkthroughs)

## Quick Reference

Cell fences:

| Fence | Cell |
| --- | --- |
| ` ```{html} ` | Learner-editable HTML, rendered in the output |
| ` ```{css} ` | Styles, usually with an `+html` fixture |
| ` ```{javascript} ` / ` ```{js} ` | JavaScript, run in the cell output |
| ` ```{node} ` | JavaScript with Node-like globals |
| ` ```{react} ` / ` ```{jsx} ` | React components with JSX |
| ` ```{mcq} ` | Multiple choice question (runs on open) |
| ` ```{external} ` / ` ```{checklist} ` | Workspace file checks (runs on open, re-checks on an interval) |
| ` ```{walkthrough} ` | Annotated walkthrough of workspace files (runs on open) |
| ` ```html id=name ` | Non-editable cell other cells can reference |

Flags go in the fence header: `{javascript autorun}`, `{html runonstart}`, `{css id=layout}`.

Addon fences, attached to the cell directly above:

| Addon | Purpose |
| --- | --- |
| ` ```+html ` | Fixture markup for a CSS or JavaScript cell |
| ` ```+css ` | Styles for an HTML cell |
| ` ```+test ` | Assertions that run after the cell (also `+javascript` / `+js`) |
| ` ```+default ` | Starter source, auto-captured on first run when left empty |
| ` ```+solution ` | Author-only reference answer; never runs or renders |
| ` ```+id=name ` | Copies another cell's source in as a fixture |
| ` ```+files ` | Extra workspace paths to snapshot for checks |
| ` ```+terminal ` | Simulated terminal (also `+xterm`) |
| ` ```+selection ` | Saved MCQ answers, written by the renderer |

## Basic Cell Format

Create a learner-editable cell with a fenced code block whose language is wrapped in braces:

````
```{lang}
content
```
````

For example, this creates an HTML cell:

````
```{html}
<h1>Hello</h1>
<button>Click me</button>
```
````

Common cell languages include:

- `html` for rendered HTML.
- `css` for styles.
- `javascript` or `js` for JavaScript.
- `node` for Node-style JavaScript exercises.
- `react` or `jsx` for React components (with JSX support).
- `mcq` for multiple choice questions.
- `external` for automatically checked workspace files and directories.
- `walkthrough` for annotated code walkthroughs of workspace files.

## Markdown Images (Sizing)

Prose between cells is regular Markdown, so images use the usual
`![alt](path)` syntax. To size an image, add a `=WIDTHxHEIGHT` suffix inside the
parentheses (the Typora / GitLab convention). Either dimension may be omitted to
preserve the aspect ratio:

```
![Diagram](images/diagram.png =300x180)   width 300, height 180
![Logo](images/logo.svg =120x)            width 120 (height auto)
![Banner](images/banner.jpg =x80)         height 80 (width auto)
![Screenshot](shot.png =400)              width 400 (height auto)
![Titled](shot.png "Hover text" =400x250) with a title
```

Sizes are in pixels and become `width` / `height` attributes on the `<img>`.
Images without a size suffix render exactly as before. Sizing works in the VS
Code notebook, in the web preview, and in Markdown shown inside outputs (MCQ
questions, checklists, and feedback).

## JavaScript Cells

JavaScript cells can define values, interact with fixture HTML, and log output:

````
```{javascript}
const x = 1;
console.log(x);
```
```+test
wrap(x).should('equal', 1).run('Failed; x should be 1', 'x is 1');
```
````

When a JavaScript cell has `+html`, the fixture markup is available through `document`:

````
```{javascript}
document.querySelector('#message').textContent = 'Hello';
```
```+html
<p id="message"></p>
```
```+test
assert('#message').should('have.text', 'Hello').run('The message was not updated', 'The message was updated');
```
````

## Node Cells

Node cells run with Node-like globals (`process`, `module`, `exports`, `__dirname`, `__filename`) so learners can practice server-side JavaScript syntax and patterns.

````
```{node}
console.log('cwd:', process.cwd());
module.exports = { answer: 42 };
```
````

`require(...)` is not available in the web notebook runtime, so dependency loading should be simulated or expressed with plain JavaScript.

## Module Syntax (`import` / `export`)

JavaScript, Node, and React cells can use ES module syntax. The runtime compiles module code automatically so `import` and `export` work inside notebook cells.

````
```{node}
import path from 'path';

export const lessonFile = path.basename('/workspace/lesson.txt');
console.log(lessonFile);
```
````

Available module imports in this runtime are:

- `react`
- `react-dom/client`
- `marked`
- `path` (lightweight compatibility helper)

## React Cells

React cells support JSX and can render into a root element in the cell output.

You can use either `react` or `jsx` as the cell language:

````
```{react}
const App = () => <h1>Hello from React</h1>;
renderReact(<App />);
```

```{jsx}
const Badge = ({ text }) => <strong>{text}</strong>;
renderReact(<Badge text="JSX alias works" />);
```
````

By default, a `#root` mount node is created automatically. If you add a custom `+html` fixture, you can mount anywhere by passing a selector, for example `renderReact(<App />, '#app')`.

## Addon Blocks

Addon blocks start with `+` and attach to the code cell immediately above them. Use addons to provide supporting code, styles, tests, or referenced content without making that content the main learner-editable cell.

### Optional Solutions

Use `+solution` to attach an author-only reference answer to a cell.

`+solution` is optional and does not run, render, or affect test execution. It is useful for storing the expected answer next to the exercise while keeping the learner-facing behavior unchanged.

### Starter Defaults

Use `+default` to preserve starter code separately from the learner-edited cell source.

If you leave `+default` empty, the first cell run captures the current cell source into `+default` automatically.

`````
```{html}
<!-- learner edits this -->
```
```+default
<!-- optional: author-defined starter code, or leave empty to auto-capture on first run -->
```
````

````
```{javascript}
// Learner task: create a function that doubles a number.
function double(n) {
  // TODO: implement
}
```
```+test
wrap(double(4)).should('equal', 8).run('double(4) should be 8', 'double works');
```
```+solution
function double(n) {
  return n * 2;
}
```
````

### CSS For HTML Cells

Add CSS to an HTML cell with `+css`:

````
```{html}
<h1>Hello</h1>
<button>Click me</button>
```
```+css
h1 {
  color: blue;
}
```
````

### HTML Fixtures For CSS Or JavaScript

Add HTML fixtures with `+html`. This is useful when a CSS or JavaScript cell needs markup to run against:

````
```{css}
h1 {
  color: red;
}
```
```+html
<h1>Hello</h1>
```
````

## Referencing Other Cells

Give a cell an ID when you want later cells to reuse its source:

````
```html id=mainpage
<h1>Main Page</h1>
```
````

Reference that source with `+id=name`. The referenced cell is attached as an addon to the current cell:

````
```html id=mainpage
<h1>Main Page</h1>
```

Write code that fetches the h1 element:
```{javascript}
const h1 = document.querySelector('h1');
```
```+id=mainpage
```
```+test
wrap(h1.innerText).should('equal', 'Main Page').run('Failed; h1 should be "Main Page"', 'h1 is "Main Page"');
```
````

This works for any cell type. For example, a non-editable HTML cell can be referenced from an editable CSS cell so the learner sees the HTML and styles it:

````
```html id=layout
<h1>Welcome</h1>
<p>Style this page.</p>
```

Edit the CSS below so the heading is green:
```{css}
/* type your CSS here */
```
```+id=layout
```
````

The `+id=layout` addon copies the HTML from the non-editable `id=layout` cell and attaches it as a fixture, so the CSS cell output renders the HTML with the learner's styles applied. IDs work the same on editable (`{lang id=...}`) and non-editable (`` ```lang id=...``) cells.

## Tests

Tests are JavaScript snippets in a `+test` addon. They run when the cell runs, after the cell has been rendered or evaluated.

### Test Helpers

The most common helpers are:

- `assert(selector)` finds rendered elements inside the current cell output.
- `assertRule(selector)` finds a CSS rule by its selector text.
- `wrap(value)` checks a JavaScript value directly.

Each helper returns a chain. Finish the chain with `.run(failMessage, successMessage)` to report feedback:

````
```{html}
<h1>Hello</h1>
<button>Click me</button>
```
```+test
assert('h1').should('exist').run('Failed; could not find h1 element', 'Created h1 element');
```
````

### Element Assertions

Supported element assertions:

- `.should('exist')`
- `.should('have.text', 'Hello')`
- `.should('have.class', 'active')`
- `.should('have.attribute', 'disabled')`
- `.should('have.css', 'color: blue')`

Supported actions:

- `.click()`
- `.type('hello')` for `<input>` and `<textarea>` elements
- `.clear()` for `<input>` and `<textarea>` elements
- `.find(selector)` or `.get(selector)` to search within the current matched elements

For example:

````
```{javascript}
document.querySelector('#greet').addEventListener('click', () => {
  document.querySelector('#message').textContent = 'Hello';
});
```
```+html
<button id="greet">Say hi</button>
<p id="message"></p>
```
```+test
assert('#greet').should('exist').click().run('Missing the button', 'Found and clicked the button');
assert('#message').should('have.text', 'Hello').run('The button should update the message', 'The button updates the message');
```
````

### CSS Tests

For CSS cells, add fixture HTML with `+html`, then test the rendered result or inspect a CSS rule:

````
```{css}
h1 {
  color: red;
}
```
```+html
<h1>Hello</h1>
```
```+test
assert('h1').should('have.css', 'color: red').run('The h1 should be red', 'The h1 is red');
assertRule('h1').should('have.css', 'color: red').run('Missing the h1 color rule', 'Found the h1 color rule');
```
````

### JavaScript Value Tests

For JavaScript cells, tests run after the learner's code and can inspect variables from that code:

````
```{javascript}
const x = 1;
const user = { name: 'Ada' };
```
```+test
wrap(x).should('equal', 1).run('x should be 1', 'x is 1');
wrap(user).should('equal', { name: 'Ada' }).run('user should match', 'user matches');
```
````

### Console Output Tests

The fake console records structured history for logs produced by JavaScript cells, test addons, and HTML event handlers such as `onclick`.

Use `check.consoleLogged(textOrRegex, label?)` when you want a checklist-style result:

````
```{html}
<button id="hello-button" onclick="console.log('Hello!')">Click me!</button>
```
```+test
assert('#hello-button').click().run('Click the button', 'Clicked the button');
check.consoleLogged('Hello!').run('The button should log `Hello!`', 'The button logged `Hello!`');
```
````

For custom assertions, use the `console` helper directly:

- `console.history()` returns `{ method, args, text, timestamp }[]`.
- `console.didLog(textOrRegex)` checks whether any console entry text matches.
- `console.clear()` clears the fake console and its history.

````
```{javascript}
console.log('score:', 10);
```
```+test
wrap(console.didLog(/score:\s*10/)).should('equal', true).run('Expected a score log', 'Logged the score');
```
````

### Source-Aware Tests

Tests can inspect the current cell source through the `source` string. Use this when you want to check how the learner wrote the answer, not just what it rendered:

````
```{html}
<h1>Hello</h1>
```
```+test
wrap(source.includes('<h1')).should('equal', true).run('Use an h1 element', 'Used an h1 element');
```
````

In JavaScript cells, `console.log(source)` prints the cell source while you are authoring or debugging the test.

### Addon Order

Addon order matters for HTML and CSS cells. Put `+css` or `+html` addons before a `+test` addon when the test depends on those styles or fixtures.

## Automatic Running

Web Notebook supports automatic execution for selected code cells when a notebook opens.

### `autorun` for Code Cells

Add `autorun` in the fenced code header to run that code cell automatically:

````
```{javascript autorun}
console.log('This runs when the notebook opens.');
```

```{html autorun}
<h1>Auto-rendered on open</h1>
```
````

Notes:

- `autorun` applies to code cells (`{javascript}`, `{html}`, `{css}`, `{node}`, `{react}`, `{jsx}`, etc.).
- Autorun cells execute automatically when the notebook becomes active.
- Autorun is intended for setup, starter rendering, or instructions that should appear immediately.
- Re-run manually after edits if you want to refresh output right away.

### `runonstart` for One-Time Setup

Add `runonstart` in the fenced code header to run a cell exactly once when the notebook first opens:

````
```{javascript runonstart}
console.log('This runs once on first open.');
```

```{html runonstart}
<h1>Welcome!</h1>
<p>This content appeared automatically when you opened the notebook.</p>
```
````

Notes:

- `runonstart` runs the cell once per notebook session. Switching tabs or re-activating the notebook does not re-run it.
- `autorun` re-runs whenever the cell content changes or the notebook becomes active again. `runonstart` does not.
- Closing and reopening the notebook resets the flag, so the cell runs again on the next open.
- You can combine flags: `{html id=intro runonstart}` gives the cell an ID and runs it once on open.

### Auto-Run Widget Cells

`{external}` / `{checklist}` and `{mcq}` cells are auto-run widget cells. They execute automatically on open without adding `autorun`.

Use `autorun` for regular code cells, and rely on built-in auto-run behavior for widget cells.

## Multiple Choice Questions

Multiple choice cells use `[x]` for correct options and `[ ]` for incorrect options:

````
```{mcq}
Which of the following are fruits? (Select all that apply)
correct: Nice work. You picked all the fruits.
wrong: Not quite. Check the feedback under each option.
[x] Apple
  correct: Apple is a fruit, so this should be selected.
  wrong: Apple is a fruit, so you should select it.
[ ] Carrot
  correct: Right. Carrot is a vegetable, so leave it unchecked.
  wrong: Carrot is a vegetable, so this should stay unchecked.
[x] Banana
  correct: Banana is a fruit, so this should be selected.
  wrong: Banana is a fruit, so you should select it.
```
````

One correct option renders as a single-choice question. Multiple correct options render as a "select all that apply" question.

Options are shuffled by default each time the cell renders. Add `deterministic: true` before the first option when you want a stable shuffle for the same cell and source:

````
```{mcq}
Which keyword declares a block-scoped variable?
deterministic: true
[ ] var
[x] let
[ ] function
```
````

Use `shuffle: false` before the first option when the source order matters:

````
```{mcq}
Which option is intentionally last?
shuffle: false
[ ] First
[ ] Second
[x] Third
```
````

### Question-Level Feedback

Question-level feedback is optional. Top-level `correct:` / `wrong:` lines apply to the whole question and must appear before the first option. If you leave them out, the question uses default feedback:

````
```{mcq}
Which language runs in the browser in this notebook example?
[x] JavaScript
[ ] Rust
[ ] Go
```
````

You can also provide only question-level feedback:

````
```{mcq}
What is the capital of France?
correct: Nice work. Paris is the capital of France.
wrong: Not quite. Paris is the capital of France.
[ ] London
[x] Paris
[ ] Berlin
```
````

### Per-Item Feedback

Indented `correct:` / `wrong:` lines under an option apply to that item specifically. Per-item feedback is optional and can be mixed: not every option needs feedback, and an option can have only `correct:`, only `wrong:`, both, or neither.

````
```{mcq}
Which statements about CSS are true? (Select all that apply)
correct: Correct. You found the true statements.
wrong: Try again. Check any notes below the choices.
[x] CSS can style HTML elements.
  correct: Right. CSS controls presentation.
[ ] CSS is the same language as HTML.
  wrong: CSS and HTML have different roles.
[x] CSS selectors can target elements by class.
[ ] CSS always requires JavaScript.
```
````

Feedback behavior:

- `correct:` is shown when the learner handled that option correctly.
- `wrong:` is shown when the learner handled that option incorrectly.
- `incorrect:` can be used instead of `wrong:`.
- Options without matching feedback simply do not show per-item feedback.

### Selection State

MCQ cells can persist learner selections in a `+selection` addon attached to the MCQ cell.

The renderer updates this addon automatically whenever selections change, so reopening or rerunning the notebook restores the learner's current choices.

````
```{mcq}
Which of these are fruits?
[x] Apple
[ ] Carrot
[x] Banana
```
```+selection
{"selected":[0,2]}
```
````

## External Checks

Use external checks when the learner needs to create files or folders in the workspace. External check cells are little widgets: they run automatically when the notebook opens, collapse their source like multiple choice cells, show each item as pass/fix feedback, and keep checking periodically until every item passes.

Paths are relative to the notebook file's directory by default. To resolve from the workspace root instead, prefix the path with `workspace:`.

Examples:

- `styles.css` resolves relative to the current `.webnb` file.
- `workspace:shared/styles.css` resolves relative to the workspace root.

External check cells automatically snapshot paths referenced by declarative checks. If an advanced `+test` builds paths dynamically, list those paths in a `+files` addon.

````
```{external}
title: Project file checklist
interval: 2s
- directory: xyz | Create a directory named `xyz`
- file: xyz/index.html | Inside `xyz`, create a file named `index.html`
- contains: xyz/index.html | <h1 | In `index.html`, create an `h1` heading
- matches: xyz/index.html | /<title>.+<\/title>/ | Add a non-empty `title` element
```
````

The widget re-runs every `interval` until all items pass. Use `interval: off` for an external check that only runs when the cell is executed.

### External Check Syntax

External check cells support these lines:

- `title: Text shown at the top of the widget`
- `interval: 2s`, `interval: 500ms`, or `interval: off`
- `directory: path | optional label`
- `file: path | optional label`
- `path: path | optional label`
- `contains: path | text | optional label`
- `not contains: path | text | optional label`
- `matches: path | regex | optional label`
- `equals: path | exact text | optional label`
- `has entry: directory | child name | optional label`
- `command: command text | optional label`

Each check can also be written as a Markdown list item with `-`, as in the example above. Use `\|` when a field needs to contain a literal pipe character.

### Optional Advanced Tests

For custom logic, add an optional `+test` addon to the same `{external}` cell. The test runs as part of the widget and can add checks with `checklist(title, items)` or `checklist(items)`.

````
```{external}
title: Project file checklist
interval: 2s
- directory: xyz | Create a directory named `xyz`
- file: xyz/index.html | Inside `xyz`, create a file named `index.html`
```
```+files
xyz/styles.css
```
```+test
checklist([
  check.file('xyz/index.html').contains('<main', 'In `index.html`, use a `main` element'),
  check.file('xyz/styles.css').contains('font-family', 'In `styles.css`, set a font family')
]);
```
````

The extension can usually detect literal paths in `check.file('...')`, `check.directory('...')`, `check.path('...')`, `check.exists('...')`, and `file('...')`. Use `+files` for paths that are generated with variables or other custom logic.

### Programmatic Check API

Programmatic checks can be created with:

- `check.directory(path, label?)` checks that `path` exists and is a directory.
- `check.file(path, label?)` checks that `path` exists and is a file.
- `check.path(path, label?)` checks that `path` exists, with any file type.
- `check.exists(path, label?)` creates an existence check directly.
- `check.command(command, label?)` checks that the simulated terminal history includes `command`.
- `check.commands(commands, label?)` checks that each command appears in order.
- `check.consoleLogged(textOrRegex, label?)` checks that the fake console history includes matching text.
- `file(path)` is a short alias for `check.file(path)`.

File and directory checks can be refined with:

- `.contains(text, label?)` checks that a file includes text.
- `.notContains(text, label?)` checks that a file does not include text.
- `.matches(regexOrString, label?)` checks file contents with a regular expression.
- `.equals(text, label?)` checks that file contents exactly match text.
- `.hasEntry(name, label?)` checks that a directory contains an entry with that name.
- `.exists(label?)`, `.isFile(label?)`, and `.isDirectory(label?)` create explicit type checks.

The raw file snapshot is also available as `files` inside tests. Each entry includes `exists`, `type`, and, for files, `content`.

### Simulated Terminal (xterm.js)

Use a `+terminal` addon to embed a simulated terminal in a cell. This does not run real shell commands; it records commands so you can guide and assess command-line practice safely.

````
```{external}
title: Run setup commands
interval: 2s
- command: mkdir xyz | Create the `xyz` folder from the terminal
- command: npm init -y | Initialize npm in the project
```
```+terminal
welcome: Follow the instructions and run the setup commands.
prompt: $ 
```
````

`+terminal` supports:

- `welcome: ...` one-time intro line shown when the terminal first appears
- `prompt: ...` prompt prefix, defaults to `$`
- `run: ...` execute a simulated startup command
- `- ...` list form for additional startup commands

Inside `+test` addons, the `terminal` helper is available:

- `terminal.run(command)` runs a simulated command and records it
- `terminal.history()` gets recorded commands
- `terminal.last()` gets the latest command
- `terminal.didRun(command)` checks if a command was run
- `terminal.clear()` resets command history

For one-off feedback in a regular JavaScript cell, call `.run(failMessage, successMessage)` on a file check and list inspected paths with `+files`:

````
```{javascript}
// Run this cell to check one file.
```
```+files
xyz/index.html
```
```+test
check.file('xyz/index.html')
  .contains('<main', 'Use a `main` element')
  .run('Add a `main` element to `xyz/index.html`.', 'Found a `main` element.');
```
````

## Code Walkthroughs

Use `{walkthrough}` cells to offer commentary on snippets of a larger codebase. A walkthrough is a sequence of steps; each step points at a workspace file, selects which lines to show, and attaches markdown commentary — including annotations pinned to specific lines. Walkthrough cells are widgets like `{mcq}` and `{external}` cells: they render automatically when the notebook opens and collapse their source.

````
```{walkthrough}
title: How the demo server works
Intro commentary shown before the first step.

step: Setup
file: demo-src/server.js
region: setup
Commentary for this step, in markdown.
@"const notes": An annotation pinned to the first shown line containing this text.

step: The helpers
file: demo-src/utils.js
lines: 3-18, 20-23
highlight: 11
@13: An annotation pinned to line 13 of the file.
```
````

### How A Cell Is Read

Each line of a walkthrough cell is one of three things:

- A **key line** such as `step:`, `file:`, or `lines:` (the full list is under [Step Keys](#step-keys)), which applies to the step being built.
- An **annotation** starting with `@`, which pins a note to a line of the shown code.
- Anything else is **markdown commentary** for the current step, rendered above its code. Commentary written before the first `step:` or `file:` line is the walkthrough's intro.

Steps are shown in the order they appear, numbered automatically when there is more than one. A walkthrough cell can mix files freely: each step names its own `file:`, so one walkthrough can read across a whole directory.

Because the cell is itself a fenced code block, commentary cannot contain a ` ``` ` fence — that would end the cell. Indent code by four spaces instead to get a code block inside commentary.

The code comes from a snapshot of the files taken when the cell runs, which happens automatically when the notebook opens. Re-run the cell to pick up later edits, or add `watch:` so it re-reads them on an interval.

### Picking Lines With Region Markers

`region: name` anchors a step to a marked region in the target file. Mark the region with `#region name` and `#endregion` comments in whatever comment style the file uses:

```js
// #region setup
const app = express();
app.use(express.json());
// #endregion
```

The marker comments themselves are not shown, the displayed line numbers match the real file, and the snippet keeps tracking the region as the file grows or shifts — which makes regions more robust than line numbers. Regions can nest; the marker names are matched case-insensitively. These are the same `#region` markers VS Code uses for code folding.

### Picking Lines By Number

`lines:` takes comma-separated line numbers or ranges, using the file's real 1-based line numbers:

```
lines: 3-18, 20-23
```

Disjoint ranges render with a `⋯` separator between them. A step with neither `region:` nor `lines:` shows the whole file. If a step has both, the region wins.

### Step Keys

- `step: title` starts a new step (a bare `file:` line also starts one).
- `file: path` is the file to show. Paths resolve relative to the notebook file; use a `workspace:` prefix (for example `workspace:src/app.js`) to resolve from the workspace root, matching external checks.
- `region: name` / `lines: ranges` select what to show.
- `highlight: ranges` emphasizes lines without attaching a note.
- `language: name` (or `lang:`) overrides the language used for syntax highlighting (`language: none` shows the snippet as plain text).
- `title:` before the first step names the whole walkthrough.
- `watch: 2s` re-runs the cell on an interval so snippets track files a learner is editing (`watch: on` uses 2 seconds; the default is off).

### Line Annotations

Annotation lines attach a note directly under a line of code and highlight it:

- `@12: note` pins to line 12 of the file.
- `@12-15: note` highlights the range and pins the note under line 15.
- `@"text": note` pins to the first shown line containing `text`, which stays correct as the file shifts.
- Indent a following line by two or more spaces to continue a note.

Annotations whose anchor is not among the shown lines render as a warning note under the code, so stale line numbers are visible instead of silently dropped.

### Syntax Highlighting

Snippets are syntax highlighted using the language guessed from the file's extension, in colors taken from the active VS Code theme. Highlighting reads the whole file, not just the shown lines, so a slice that starts inside a template literal or a block comment still gets the right colors.

Use `language:` to name the language yourself when a file has no extension or an unusual one, and `language: none` to turn highlighting off for a step:

```
step: The launcher script
file: workspace:bin/serve
language: bash
```

Web languages (JavaScript, TypeScript, JSX, HTML, CSS, SCSS, JSON, Markdown) are covered along with common others (Python, Bash, Java, C/C++, C#, Go, Rust, PHP, Ruby, SQL, YAML, INI/TOML, Dockerfile, diffs). A file in a language that is not covered still shows, just without color.

### Reading And Opening The Real File

Hovering a line of a snippet tints it, the way VS Code highlights the row under the pointer, which makes it easy to keep your place while reading and to see which line a note belongs to. This is separate from `highlight:` and annotation emphasis, which stay visible on their own.

If the file is already open in another editor tab, the walkthrough mirrors your reading position there. Hovering anywhere in a step marks every line that step shows; pointing at one line of the snippet marks that line more strongly within the region. The editor scrolls to whatever you point at when it sits outside the viewport. Only editors that already show the file react — hovering never opens one — and the marks clear when the pointer leaves the step.

Every rendered snippet also links back to the source. The file name above the code opens the real file beside the notebook, scrolled to the first shown line, and each line number in the gutter opens the file at that exact line — hovering a line brightens its number to point that out.

See `samplenotebooks/walkthrough.webnb` for a complete example that walks through `samplenotebooks/demo-src/`.
