# Web Notebook

Web Notebook files are Markdown documents with executable tutorial cells. Use fenced code blocks for learner-editable cells, and attach addon blocks for fixtures, styles, tests, or references.

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

## External Checks

Use external checks when the learner needs to create files or folders in the workspace. External check cells are little widgets: they run automatically when the notebook opens, collapse their source like multiple choice cells, show each item as pass/fix feedback, and keep checking periodically until every item passes.

Paths are relative to the workspace folder that contains the notebook. External check cells automatically snapshot paths referenced by declarative checks. If an advanced `+test` builds paths dynamically, list those paths in a `+files` addon.

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

## Development Loop

For a faster VS Code Web development loop, run:

```sh
npm run in-browser:watch
```

This watches the source files, runs webpack development builds as they change, waits for the first successful build, launches VS Code Web, opens `samplenotebooks/sample.webnb`, and reloads VS Code Web whenever the compiled output changes. The wrapper also reopens the target notebook on each reload signal so the file stays in front.

If you only want webpack watching without opening VS Code Web, run:

```sh
npm run dev:web
```

The browser launch uses `scripts/vscode-test-web.js`, a small wrapper around the `@vscode/test-web` API. It opens `samplenotebooks/sample.webnb` by default through the npm scripts above. With `--watch`, the wrapper rebuilds with webpack after source changes, watches the compiled extension output in `out/` plus `package.json`, and reloads VS Code Web after a rebuild.

You can launch once without the reload watcher:

```sh
npm run in-browser:open
```

You can also pass a different file path with `--file`:

```sh
npm run test-web -- --file sample.webnb
npm run test-web -- --workspace . samplenotebooks/sample.webnb
```

`vscode-test-web` does not watch or reload by itself. The `--watch` flag in `scripts/vscode-test-web.js` adds that development loop around it. The regular `npm run in-browser` command still does a one-time development build before launching.
