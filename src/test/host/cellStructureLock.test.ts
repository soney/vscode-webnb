import './tdd';
import * as assert from 'assert';
import { CellStructureLock } from '../../extension/cellStructureLock';
import * as stub from './vscodeStub';
import { encode, openNotebook, settle, wait } from './helpers';

const NOTEBOOK = '# A\n\n```{javascript}\nx = 1\n```\n\nB\n';

suite('extension/cellStructureLock', () => {
    let lock: CellStructureLock | undefined;
    setup(() => stub.resetStub());
    teardown(() => lock?.dispose());

    function texts(notebook: stub.FakeNotebook): string[] {
        return notebook.getCells().map(cell => cell.document.getText());
    }

    function serveDisk(text: string): void {
        stub.testing.fs.readFile = async () => encode(text);
    }

    test('a deleted cell is put back', async () => {
        const { notebook } = openNotebook(NOTEBOOK);
        lock = new CellStructureLock();
        notebook.splice(1, 1, []);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['# A', 'x = 1', 'B']);
    });

    test('a reload from disk (clean, and equal to the file) stands', async () => {
        const { notebook } = openNotebook(NOTEBOOK);
        lock = new CellStructureLock();
        const newer = NOTEBOOK.replace('x = 1', 'x = 2   // updated on disk');
        serveDisk(newer);
        // What VS Code sends for a reload: one Replace over the changed cell, not dirty.
        notebook.splice(1, 1, [notebook.createCell({ value: 'x = 2   // updated on disk', languageId: 'javascript' })], { dirty: false });
        await settle();
        assert.deepStrictEqual(texts(notebook), ['# A', 'x = 2   // updated on disk', 'B']);
        assert.strictEqual(stub.testing.messages.length, 0);
    });

    test('a dirty change that happens to match the file is still reverted', async () => {
        const { notebook } = openNotebook(NOTEBOOK);
        lock = new CellStructureLock();
        serveDisk('# A\n\nB\n');
        notebook.splice(1, 1, []);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['# A', 'x = 1', 'B']);
    });

    test('Split Cell is undone whole: the cell gets its text after the cursor back', async () => {
        const { notebook } = openNotebook('```{javascript}\nline 1\nline 2\n```\n');
        lock = new CellStructureLock();
        const cell = notebook.cellAt(0);
        // VS Code's split: one bulk edit, the cell keeps the text before the cursor...
        cell.document.setText('line 1\n', notebook);
        // ...and a new cell below gets the rest.
        notebook.splice(1, 0, [notebook.createCell({ value: 'line 2', languageId: 'javascript' })]);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['line 1\nline 2']);
    });

    test('Join is undone whole: the joined text leaves the cell above', async () => {
        const { notebook } = openNotebook('```{javascript}\na\n```\n\n```{javascript}\nb\n```\n');
        lock = new CellStructureLock();
        notebook.cellAt(0).document.setText('a\nb', notebook);
        notebook.splice(1, 1, []);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['a', 'b']);
    });

    test('inserting a cell right after typing leaves the typed text alone', async () => {
        const { notebook } = openNotebook('```{javascript}\na\n```\n');
        lock = new CellStructureLock();
        notebook.cellAt(0).document.setText('ab', notebook);
        notebook.splice(1, 0, [notebook.createCell({ value: 'pasted', languageId: 'javascript' })]);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['ab']);
    });

    test('past the runaway limit, reverts wait and are then applied, never dropped', async () => {
        const { notebook } = openNotebook('```{javascript}\n0\n```\n\n```{javascript}\n1\n```\n\n```{javascript}\n2\n```\n\n```{javascript}\n3\n```\n\n```{javascript}\n4\n```\n');
        lock = new CellStructureLock({ maxRevertsPerWindow: 2, burstWindowMs: 100 });
        // Holding Delete: cells go faster than the lock is allowed to answer.
        for (let round = 0; round < 5; round++) {
            notebook.splice(0, 1, []);
            await settle(2);
        }
        await wait(250);
        await settle();
        assert.deepStrictEqual(texts(notebook), ['0', '1', '2', '3', '4']);
    });
});
