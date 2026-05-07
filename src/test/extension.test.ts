import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { parseMarkdown } from '../extension/markdownParser';
// import * as myExtension from '../extension';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Sample test', () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

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

    assert.strictEqual(cells.length, 2);
    assert.strictEqual(cells[1].kind, vscode.NotebookCellKind.Markup);
    assert.match(cells[1].content, /```javascript[\s\S]*return x \+ y;[\s\S]*```/);
  });
});
