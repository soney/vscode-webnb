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
- `mcq` for multiple choice questions.

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
