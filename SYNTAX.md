# Web Notebook Syntax

A Web Notebook (`.webnb`) file is a Markdown document with executable tutorial cells. Prose between cells is ordinary Markdown; a fenced code block whose language is wrapped in braces -- ` ```{html} ` -- becomes a learner-editable cell, and fenced blocks starting with `+` attach addons (fixtures, styles, tests, references) to the cell above them.

This file is the complete, self-contained authoring reference for the `.webnb` format.

## Contents

- [Basic Cell Format](#basic-cell-format)
- [Output Pane Height](#output-pane-height)
- [Markdown Images (Sizing)](#markdown-images-sizing)
- [Links Between Notebooks](#links-between-notebooks)
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

Flags go in the fence header: `{javascript autorun}`, `{html runonstart}`, `{css id=layout}`, `{html hidecode}`, `{html height=300}`.

Addon fences, attached to the cell directly above:

| Addon | Purpose |
| --- | --- |
| ` ```+html ` | Fixture markup for a CSS or JavaScript cell |
| ` ```+css ` | Styles for an HTML cell |
| ` ```+test ` | Assertions that run after the cell (also `+javascript` / `+js`) |
| ` ```+default ` | Starter source behind the "Reset code" button; captured automatically when absent |
| ` ```+solution ` | Reference answer; never runs, shown only when the reader clicks "View solution" |
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

### Fences and Attributes

A cell or addon fence is three or more backticks, and it ends at the first line
that is only a backtick fence at least as long (CommonMark's rule), so a line
like ```` ```js ```` inside a cell is content, not an end. A cell whose content
itself has a line starting with ```` ``` ```` is saved with a longer fence
(```` ```` ````) so the file reads back the same.

The words after the language are read one at a time: `id=name`, `height=300`,
and the flags `autorun`, `runonstart` and `hidecode`. Anything else is kept as
written, in its place, and so is the language spelling (`{jsx}` stays `{jsx}`),
so saving a notebook never rewrites a fence header.

A block the notebook cannot use -- an addon with no code cell directly above
it, a `+id=` naming no cell above it, a fence that is never closed -- is shown
as plain text, with a warning in the "Web Notebook" log, and saved back exactly
as it was. An addon belongs to the code cell directly above it: only blank lines
and that cell's other addons may come between them.

## Output Pane Height

A cell's output pane is at least 120 pixels tall and grows with its content. Add
`height=` to the fence to set the height yourself:

````
```{html height=300}
<h1>Hello</h1>
```
````

A bare number is pixels, as with image sizes; these CSS units work too: `px`,
`em`, `rem`, `%`, `vh`, `vw`, `ch`, `ex`, `pt`, `pc`, `cm`, `mm`, and `in`:

```
{html height=300}     300 pixels
{html height=300px}   the same
{html height=20em}
{html height=50vh}
{html height=auto}    no fixed height: the pane fits its content
```

A pane held at a height keeps it whether or not the content fills it, and
scrolls when the content is taller. That covers both a demo that needs room and
output long enough to bury the rest of the notebook. `height=auto` is the
opposite: it drops the 120-pixel floor so a one-line output takes one line.

The attribute works on any cell that renders output (`html`, `css`, and the
JavaScript, Node, and React cells) and combines with the other flags in any
order: `{react hidecode height=400}`. On a JavaScript or Node cell it also shows
the output pane, which is otherwise hidden unless the cell has an `+html`
fixture, so a cell that writes into `document.body` itself has somewhere visible
to put it. `height=auto` does not do this: it asks for less space, not for a
pane.

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

## Links Between Notebooks

An ordinary Markdown link whose target is a `.webnb` file opens that notebook:

```
Recap: [how events work](events.webnb).
```

Add `#section` to land on a heading rather than at the top:

```
Recap: [how events work](events.webnb#listening-for-a-click).
```

A section anchor is a heading turned into a slug: lowercased, spaces replaced by
hyphens, punctuation dropped. `## Listening For A Click` is `#listening-for-a-click`,
and ``## The `fetch` API, really?`` is `#the-fetch-api-really` -- the markup comes
off, because the slug is built from the words a reader sees. If it is easier, write
the heading out and let the notebook slugify it: `[...](<events.webnb#Listening For A Click>)`
finds the same section. Anchors match the heading `id`s VS Code renders, so the
same `#section` also works in the outline and in a copied heading link.

Two details of those `id`s carry over. The text of a code span counts as written,
so ``## The `<style>` Element`` is `#the-style-element`. And a heading repeated
within one markdown cell gets a number: the second `## Summary` in a cell is
`#summary-1`, the third `#summary-2`.

For a section of the *same* notebook, write the slug itself (`[x](#listening-for-a-click)`),
not the spelled-out heading: VS Code rewrites a link that starts with `#` before
the notebook ever sees it, and a spelled-out heading does not survive that.

### Where the link can point

| Written as | Resolves to |
| --- | --- |
| `[x](events.webnb)` | Next to the notebook the link is in |
| `[x](<../Module 2/events.webnb>)` | Relative to the notebook the link is in |
| `[x](</Course 1/Module 2/events.webnb>)` | From the workspace root |
| `[x](#a-section-here)` | A section of this same notebook |

Prefer relative links: the workspace root is not the same folder everywhere a
notebook is opened (one deployment opens the notebooks folder itself, another a
repository that contains it), so a link starting with `/` may resolve in one and
not the other. A link cannot leave the workspace folder.

Filenames with spaces in them need angle brackets, because a Markdown link
destination cannot contain a bare space:

```
[Callbacks](<Module 3 - Events/04 - Callbacks.webnb>)
[Callbacks](<Module 3 - Events/04 - Callbacks.webnb#why-callbacks>)
```

Links work in prose between cells and in the Markdown shown inside outputs (MCQ
questions, checklists, walkthrough notes). Links to anything that is not a
notebook -- a web page, a source file in the workspace -- behave as they always
have, and so do links inside a learner's own rendered page: an `<a href="#settings">`
in an HTML cell's output belongs to that page.

### When a link cannot be followed

Nothing is silently ignored. A link to a notebook that does not exist reports
that no notebook is there; a link to a section that does not exist opens the
notebook and reports the missing section. Both name the link as written, so the
typo is visible without hunting for it.

Renaming a heading changes its anchor, and renaming a file breaks every link
pointing at it. Neither is checked when the notebook is saved.

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

### The Page a Cell Sees

Each cell's code runs as if its output were the whole page:

- `document` is scoped to the cell. `document.querySelector` and `getElementById`
  find the cell's own elements, `document.body` is its output pane, and
  `document.createElement` works as usual. `window.document === document`.
- Timers (`setTimeout`, `setInterval`, `requestAnimationFrame`) and listeners added
  to `window` or `document` stop when the cell runs again, so re-running an
  animation does not start a second copy of it.
- An error thrown later -- from a timer, an event listener, or a rejected
  promise nobody caught -- appears in the cell's console as `Uncaught ...` or
  `Uncaught (in promise) ...`, the way a browser console shows it. These lines
  are not console calls, so `console.history()` does not include them.
- A loop that keeps running for more than 5 seconds is stopped with an error
  that says so. (A deliberate short busy-wait, such as a 1.5 second demo of a
  frozen page, runs to completion.)
- `{javascript}` cells, and any cell that uses `import`/`export`, run in strict
  mode, so assigning to a name that was never declared (`x = 5`) throws a
  `ReferenceError` there.

## Node Cells

Node cells run with Node-like globals (`process`, `module`, `exports`, `__dirname`, `__filename`) so learners can practice server-side JavaScript syntax and patterns.

````
```{node}
console.log('cwd:', process.cwd());
module.exports = { answer: 42 };
```
````

`require(...)` resolves the same small set of modules `import` does (listed under Module Syntax below): `react`, `react-dom/client`, `marked`, and `path`. Any other module name throws an error saying it is not available in the notebook runtime, so other dependency loading should be simulated or expressed with plain JavaScript.

A Node cell's own declarations may reuse the names of the notebook helpers (`const file = 'notes.txt'` is fine); inside that cell the name then means the learner's value.

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

`renderReact` renders synchronously, so a `+test` can check the output right away, and `assert(...).click()` (or `.type()`) in a React cell applies the state update it causes before the next assertion: a test can click a button and check the new count on the next line, with no `setTimeout`. `ReactDOM.createRoot(el).render(...)` behaves the same way. A component that throws while rendering shows its error in the cell's console instead of leaving the output blank.

## Addon Blocks

Addon blocks start with `+` and attach to the code cell immediately above them. Use addons to provide supporting code, styles, tests, or referenced content without making that content the main learner-editable cell.

### Optional Solutions

Use `+solution` to attach a reference answer to a cell.

`+solution` never runs and never affects test execution. Every cell with a `+solution` gives readers a **"View solution"** button beneath its output; the solution (syntax-highlighted) appears only when the reader chooses to click it. A deployment can remove those buttons entirely -- for example during an assessment -- with the host's reveal setting (in VS Code, **`webnb.allowRevealingSolutions`**, on by default); cells that are already rendered refresh on their own when it changes.

````
```{javascript}
// Learner task: implement triple(n).
function triple(n) {
  // TODO
}
```
```+solution
function triple(n) {
  return n * 3;
}
```
````

### Starter Defaults

Use `+default` to preserve starter code separately from the learner-edited cell source.

Cells without a `+default` take care of themselves: the first time someone edits such a cell, the text it had when the notebook was opened -- even if that was nothing -- is captured as its `+default` automatically (and persists into the file on save). Running a cell never changes its addons, and an existing `+default` is never rewritten. An empty `+default` means the starter is empty: the cell shipped empty. Write an explicit `+default` only when the starter should differ from the text the cell ships with.

Whenever a cell's code differs from its starter, learners get a **"Reset code"** button under the cell's output. Clicking it restores the starter source and re-runs the cell. The reset button does not depend on the show-solutions setting -- restoring starter code never leaks an answer.

A whole notebook can be restored in one step with the **"Restore Notebook to Starter State"** command (in VS Code: the notebook toolbar, or the editor title bar where the notebook toolbar is hidden, or the command palette). After asking, it resets every cell that has a starter, clears saved multiple choice answers and terminal history, and re-runs the cells that run on their own. One undo brings everything back -- useful after accidentally working through a notebook in a source checkout.

````
```{html}
<!-- learner edits this -->
```
```+default
<!-- optional: author-defined starter code (leave out to capture the shipped text on first edit) -->
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

The referenced cell must come earlier in the notebook than the `+id=` that names it; a reference to a later or missing cell is shown as plain text (see Fences and Attributes).

## Tests

Tests are JavaScript snippets in a `+test` addon. They run when the cell runs, after the cell has been rendered or evaluated.

### Test Helpers

The most common helpers are:

- `assert(selector)` finds rendered elements inside the current cell output.
- `assertRule(selector)` finds a CSS rule by its selector text.
- `wrap(value)` checks a JavaScript value directly.

Each helper returns a chain. Finish the chain with `.run(failMessage, successMessage)` to report feedback. Every `.run()` adds its result to the ones already reported (results from `check.*().run()` and `file().run()` included), so a test shows every check it made, in order:

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
- `.should('have.text', 'Hello')` -- compared the way a reader sees the text:
  runs of whitespace count as one space and the ends are trimmed, so the line
  breaks Format Document puts inside `<li>` do not matter. Capitalization and
  punctuation still do.
- `.should('contain.text', 'Hel')` -- the text includes the expected part.
- `.should('have.class', 'active')`
- `.should('have.attr', 'href')` / `.should('have.attribute', 'disabled')` --
  pass a third argument to check the value too: `.should('have.attr', 'x', '20')`.
- `.should('have.css', 'color: blue')`
- `.should('have.length', 3)` -- how many elements matched.
- `.should('contain', 'li')` -- each matched element has a descendant matching
  that *selector* (not text; use `contain.text` for text).
- `.should('have.value', 'Ada')` -- a form field's current value.
- `.should('be.visible')`, `.should('be.checked')`, `.should('be.disabled')`
- `.should('have.property', 'value', 'Ada')` -- the DOM *property*, not the
  attribute. Use this when the two diverge: typing into an `<input>` changes
  `.value` but leaves the `value` attribute at whatever the HTML said. The
  expected value is optional; without it the assertion only checks the property
  exists.

Every assertion also has a negated form with a `not.` prefix: `.should('not.exist')`,
`.should('not.have.class', 'active')`. They work on SVG elements as well as HTML
ones.

An assertion name the notebook does not know fails the test with a message listing
the ones it does, rather than passing by accident. A chain that selects elements
and asserts nothing, such as `assert('#go').click().run(...)`, fails when the
selector matched nothing.

Supported actions:

- `.click()`
- `.type('hello')` for `<input>` and `<textarea>` elements (React controlled
  inputs see the change too)
- `.clear()` for `<input>` and `<textarea>` elements
- `.find(selector)` or `.get(selector)` to search within the current matched elements
- `.contains('text')` to narrow to the innermost matched elements whose text includes it

An action on a selector that matched nothing fails the test instead of quietly
doing nothing.

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

`assertRule(selector)` reads only the cell's own CSS: the cell, its `+css` addons,
and any `<style>` in its markup, never another cell's rules. When several rules
use exactly that selector, their declarations are combined in order and later
ones win, as they do on a page.

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

`equal` compares deeply, so objects, arrays, `Date`s, `Map`s and `Set`s are
compared by what they hold rather than by identity. Values of different kinds
are never equal -- `[1, 2]` does not match `{ 0: 1, 1: 2 }` -- and `NaN` equals
`NaN`, so a test can assert a computation produced it.

`eq` and `deep.equal` are accepted as other names for `equal`.

More assertions work on wrapped values:

- `.should('be.an', 'array')` / `.should('be.a', 'string')` -- checks the type.
  Accepts `array`, `object`, `string`, `number`, `boolean`, `null`, `function`
  (async and generator functions count), `date`, `regexp`, `map`, `set`,
  `error`, `promise`, `symbol`, `bigint`, and `element` for a DOM node. `object`
  means a plain object or class instance: unlike `typeof`, an array and a
  `null` are not objects here.
- `.should('be.true')`, `.should('be.false')`, `.should('be.null')`,
  `.should('be.undefined')` -- exactly that value.
- `.should('include', part)` -- a string contains `part`, or an array contains
  an element deeply equal to it.
- `.should('have.property', 'name')` -- checks the property exists. Pass a third
  argument to check its value too, compared with the same deep equality as
  `equal`.
- `.should('have.length', 2)` and `.should('exist')` also work on wrapped values.

`wrap()` of a DOM element (or a list of them) takes the element assertions
above: `wrap(document.querySelector('p')).should('have.text', 'Hi')`. An element
assertion on a plain value, or a value assertion such as `equal` on
`assert(...)`, fails with a message saying so.

````
```{javascript}
const scores = [10, 20];
const user = { name: 'Ada', tags: ['admin'] };
```
```+test
wrap(scores).should('be.an', 'array').run('scores should be an array', 'scores is an array');
wrap(scores).should('have.property', 'length', 2).run('expected two scores', 'got two scores');
wrap(user).should('have.property', 'name', 'Ada').run('name should be Ada', 'name is Ada');
wrap(user).should('have.property', 'tags', ['admin']).run('tags should match', 'tags match');
wrap(user).should('not.have.property', 'password').run('do not store a password', 'no password stored');
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

An uncaught error shown in the console (see The Page a Cell Sees) is not part of
its history.

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

In JavaScript, Node, and React cells, a `+id=name` reference to another JavaScript
cell runs *before* the cell's own code, the way an earlier `<script>` tag would;
`+test` and `+js` addons run after it.

When test code throws after an earlier check has already failed (typically
because an element the test needs is missing), the cell reports "The remaining
checks could not run until the ones above pass" instead of the raw error.

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
- Autorun cells execute when the notebook is first shown, and again whenever that cell's own text changes: editing one autorun cell re-runs only that cell. Showing the notebook again does not re-run them.
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
- `autorun` re-runs whenever the cell's content changes. `runonstart` does not.
- Closing and reopening the notebook resets the flag, so the cell runs again on the next open.
- You can combine flags: `{html id=intro runonstart}` gives the cell an ID and runs it once on open.

### `hidecode` for Output-Only Cells

Add `hidecode` in the fenced code header to show only what the cell produces.
The source opens collapsed and the cell **runs on its own**, like a widget cell
-- you do not need to add `autorun`:

````
```{javascript hidecode}
const box = document.querySelector('#thermometer');
box.textContent = 'Drag the slider to convert.';
```
```+html
<div id="thermometer"></div>
```
````

The reader sees the widget and the markdown around it, not the code that built
it.

Notes:

- It runs itself. A hidden cell with a Run button would ask the reader to
  execute something they cannot see, so `hidecode` implies auto-running, the
  same way `{mcq}` and `{external}` cells do.
- Add `runonstart` alongside it if the cell must run exactly once per session
  rather than again after each edit.
- Build the widget in a `{javascript}` cell with a `+html` addon for its markup,
  as above. An `{html}` cell is set with `innerHTML`, so a `<script>` tag inside
  one never runs -- put the script in the cell, not in the markup.
- The output is unaffected: only the input is collapsed.
- **It is not a secret.** A reader can still expand the cell (it then stays
  expanded for the session), because collapsing is as far as the notebook API
  goes. Use `hidecode` for code that is noise --
  the plumbing behind a widget -- and `+solution` (with
  `webnb.allowRevealingSolutions`) for anything a reader is not meant to see
  yet.
- It combines with the other flags: `{javascript id=chart hidecode}`.

### Auto-Run Widget Cells

`{external}` / `{checklist}` and `{mcq}` cells are auto-run widget cells. They execute automatically on open without adding `autorun`.

Use `autorun` for regular code cells, and rely on built-in auto-run behavior for widget cells.

Widget cells also open with their source collapsed, as if they carried
`hidecode`. You do not need to add the flag to them.


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

### Code Samples in a Question

A question is markdown, so it can show a code sample. Fence it with **tildes**,
not backticks:

````
```{mcq}
Which line declares a constant?

~~~js
const x = 1;
let y = 2;
~~~

[x] The `const` line
[ ] The `let` line
```
````

Tildes are what make this work: the cell's own ```` ``` ```` fence ends at the
first line with a backtick fence at least as long, so a backtick fence inside a
question would cut the cell in half. A `~~~` fence is invisible to that rule, and
it takes a language, so the sample is syntax-highlighted like any other code block.

Lines inside the sample are code, never question syntax: a `correct: false,` or a
`[x]` inside the fence is shown as written, not read as feedback or an option.

Indenting a sample by four spaces also produces a code block, but Markdown's
indented code carries no language, so it renders unhighlighted. Prefer `~~~`.

Both work in a question nested inside a list item: a cell indented to sit in the
list has that shared indentation stripped before rendering, so indentation you
add on top of it still means what it means. For short fragments, inline
backticks are fine -- `` `.note` `` -- and need no fence at all.

### Revealing the Answer

Every multiple choice cell gets a **"Show Answer"** button next to "Check Answer", so readers can choose to reveal the answer. It marks the correct option(s) without changing what the reader has selected, and toggles back off. If the cell also has a `+solution` addon, its content renders (as markdown) beneath the options as the explanation:

````
```{mcq}
Which method adds an element to the end of an array?
[x] push
[ ] pop
[ ] shift
```
```+solution
`push` appends to the end; `pop` removes from the end, and `shift` removes from the front.
```
````

A deployment that should not offer answer-revealing (an assessment, say) can turn the buttons off with the host's reveal setting (`webnb.allowRevealingSolutions` in VS Code).

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

Paths are relative to the notebook file's directory by default. To resolve from the workspace root instead, prefix the path with `workspace:`. A path may not contain `..` segments or be absolute, and cannot reach outside the workspace folder (a symbolic link that leads out of it reads as missing).

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

The widget re-runs every `interval` until all items pass. Use `interval: off` for an external check that only runs when the cell is executed. A cell with a `+terminal` addon ignores `interval`: it re-checks each time a command runs instead.

### External Check Syntax

External check cells support these lines:

- `title: Text shown at the top of the widget`
- `interval: 2s`, `interval: 500ms`, or `interval: off`. Always write an
  explicit unit: a bare number (`interval: 500`) means **milliseconds** here,
  but a bare number in a walkthrough's `watch:` means **seconds**.
- `directory: path | optional label`
- `file: path | optional label`
- `path: path | optional label`
- `contains: path | text | optional label`
- `not contains: path | text | optional label`
- `matches: path | regex | optional label` -- written as `/pattern/flags` or a
  bare pattern. The `s` flag is always added, so `.` also matches a line break
  and a pattern can span lines.
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

The commands a learner runs are saved in the cell (as a `+history` addon the
notebook writes itself), so a terminal checklist keeps its progress when the
notebook is closed or the lab reloads. Restoring the notebook to its starter
state clears it. Startup commands are not saved on their own.

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

Use `{walkthrough}` cells to offer commentary on snippets of a larger codebase. A walkthrough is a sequence of steps; each step points at a workspace file, selects which lines to show, and attaches markdown commentary -- including annotations pinned to specific lines. Walkthrough cells are widgets like `{mcq}` and `{external}` cells: they render automatically when the notebook opens and collapse their source.

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

Because the cell is itself a fenced code block, a ` ``` ` fence in its commentary would end the cell. Indent code by four spaces instead to get a code block inside commentary, or use `~~~` fences (or open the walkthrough cell itself with a longer fence, ```` ```` ````, which a three-backtick line cannot close).

The code comes from a snapshot of the files taken when the cell runs, which happens automatically when the notebook opens. Re-run the cell to pick up later edits, or add `watch:` so it re-reads them on an interval.

### Picking Lines With Region Markers

`region: name` anchors a step to a marked region in the target file. Mark the region with `#region name` and `#endregion` comments in whatever comment style the file uses:

```js
// #region setup
const app = express();
app.use(express.json());
// #endregion
```

The marker comments themselves are not shown, the displayed line numbers match the real file, and the snippet keeps tracking the region as the file grows or shifts -- which makes regions more robust than line numbers. Regions can nest; the marker names are matched case-insensitively. These are the same `#region` markers VS Code uses for code folding.

### Picking Lines By Number

`lines:` takes comma-separated line numbers or ranges, using the file's real 1-based line numbers:

```
lines: 3-18, 20-23
```

Disjoint ranges render with a separator (a midline ellipsis) between them. A step with neither `region:` nor `lines:` shows the whole file. If a step has both, the region wins.

### Step Keys

- `step: title` starts a new step (a bare `file:` line also starts one).
- `file: path` is the file to show. Paths resolve relative to the notebook file; use a `workspace:` prefix (for example `workspace:src/app.js`) to resolve from the workspace root, matching external checks. As there, `..` segments and absolute paths are not allowed; the step says so rather than reporting the file missing.
- `region: name` / `lines: ranges` select what to show.
- `highlight: ranges` emphasizes lines without attaching a note.
- `language: name` (or `lang:`) overrides the language used for syntax highlighting (`language: none` shows the snippet as plain text).
- `title:` before the first step names the whole walkthrough.
- `watch: 2s` re-runs the cell on an interval so snippets track files a learner is editing (`watch: on` uses 2 seconds; the default is off). Always write an explicit unit: a bare number (`watch: 30`) means **seconds** here, but a bare number in a checklist's `interval:` means **milliseconds**.

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

If the file is already open in another editor tab, the walkthrough mirrors your reading position there. Hovering anywhere in a step marks every line that step shows; pointing at one line of the snippet marks that line more strongly within the region. The editor scrolls to whatever you point at when it sits outside the viewport. Only editors that already show the file react -- hovering never opens one -- and the marks clear when the pointer leaves the step.

Every rendered snippet also links back to the source. The file name above the code opens the real file beside the notebook, scrolled to the first shown line, and each line number in the gutter opens the file at that exact line -- hovering a line brightens its number to point that out.
