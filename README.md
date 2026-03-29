# Web Notebook

Creating a user-editable code cell:

````
```{lang}
content
```
````

For example, for a user-editable HTML cell:

````
```{html}
<h1>Hello</h1>
<button>Click me</button>
```
````


You can add CSS styles to HTML via an "addon" cell:

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


You can also add tests:

````
```{html}
<h1>Hello</h1>
<button>Click me</button>
```
```+test
assert('h1').should('exist').run('Failed; could not find h1 element', 'Created h1 element');
```
````


For letting users write JavaScript code, you can use:

````
```{javascript}
const x = 1;
console.log(x);
```
```+test
wrap(x).should('equal', 1).run('Failed; x should be 1', 'x is 1');
```
````


You can also have cells with IDs that are referenced in other cells:

````
```html id=mainpage
<h1>Main Page</h1>
```

Write code that fetches the h1 element:
```{javascript}
const h1 = null; // replace
```
```+id=mainpage
```
```+test
wrap(h1.innerText).should('equal', 'Main Page').run('Failed; h1 should be "Main Page"', 'h1 is "Main Page"');
```
````

Multiple choice cells support question-level feedback plus optional per-item feedback:

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

Top-level `correct:` / `wrong:` lines apply to the whole question. Indented `correct:` / `wrong:` lines under an option apply to that item specifically:

- `correct:` is shown when the learner handled that option correctly.
- `wrong:` is shown when the learner handled that option incorrectly.
