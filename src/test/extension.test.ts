import './unit/tddBridge';
import * as assert from 'assert';

// `vscode` is the real module under vscode-test and the stub in
// host/vscodeStub.ts under `npm run test:unit` (see setup/vscodeHook.ts).
import * as vscode from 'vscode';
import { parseMarkdown, writeCellsToMarkdown } from '../extension/markdownParser';

suite('Extension Test Suite', () => {
  test('Plain fenced markdown blocks keep blank lines inside the same markdown cell', () => {
    const cells = parseMarkdown([
      '# Sample Notebook',
      '',
      'This is an example of a notebook.',
      '',
      '```javascript',
      'function add(x, y) {',
      '  if (x < 0 || y < 0) {',
      '    return "Invalid input";',
      '  }',
      '',
      '  return x + y;',
      '}',
      '```'
    ].join('\n'));

    // Each paragraph is its own markup cell; the fenced block, blank line and
    // all, is the third.
    assert.strictEqual(cells.length, 3);
    assert.strictEqual(cells[2].kind, vscode.NotebookCellKind.Markup);
    assert.match(cells[2].content, /```javascript[\s\S]*return x \+ y;[\s\S]*```/);
  });

  test('Indented webnb code fences strip list indentation from code cell content only', () => {
    const cells = parseMarkdown([
      '- Testing',
      '  ',
      '  ```{javascript}',
      '  console.log("hello");',
      '  ```'
    ].join('\n'));

    const codeCell = cells.find(cell => cell.kind === vscode.NotebookCellKind.Code);
    assert.ok(codeCell);
    assert.strictEqual(codeCell.indentation, '  ');
    assert.strictEqual(codeCell.content, 'console.log("hello");');
  });

  test('Indented webnb code fences keep source indentation when serialized', () => {
    const codeCell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'console.log("hello");',
      'javascript'
    );
    codeCell.metadata = { indentation: '  ' };

    assert.strictEqual(
      writeCellsToMarkdown([codeCell]),
      [
        '  ```{javascript}',
        '  console.log("hello");',
        '  ```',
        ''
      ].join('\n')
    );
  });
});
