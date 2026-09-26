import './tdd';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { AutorunScheduler } from '../../extension/autorunScheduler';
import * as stub from './vscodeStub';
import { openNotebook, wait } from './helpers';

const NOTEBOOK = [
    '```{javascript autorun}',
    'console.log("red")',
    '```',
    '',
    '```{mcq}',
    'Q1',
    '- [x] a',
    '```',
    '',
    '```{mcq}',
    'Q2',
    '- [x] b',
    '```',
    ''
].join('\n');

suite('extension/autorunScheduler', () => {
    setup(() => stub.resetStub());

    function createScheduler(runs: string[], delayMs = 0): AutorunScheduler {
        return new AutorunScheduler({
            notebookType: 'web-notebook',
            ensureControllerAssociation() { },
            async executeRanges(notebook, ranges) {
                for (const range of ranges) {
                    for (const cell of notebook.getCells(range)) {
                        runs.push(`${cell.index}:${cell.document.getText().split('\n')[0]}`);
                        await wait(delayMs);
                    }
                }
                return true;
            }
        });
    }

    test('runs every autorun and widget cell once when the notebook opens', async () => {
        const runs: string[] = [];
        const { editor } = openNotebook(NOTEBOOK);
        const scheduler = createScheduler(runs);
        scheduler.runForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        scheduler.runForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.deepStrictEqual(runs, ['0:console.log("red")', '1:Q1', '2:Q2']);
    });

    test('editing one autorun cell re-runs that cell only', async () => {
        const runs: string[] = [];
        const { notebook, editor } = openNotebook(NOTEBOOK);
        const scheduler = createScheduler(runs);
        scheduler.runForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        runs.length = 0;

        notebook.cellAt(0).document.setText('console.log("blue")', notebook);
        scheduler.runForNotebook(notebook as unknown as vscode.NotebookDocument);
        await wait(20);
        assert.deepStrictEqual(runs, ['0:console.log("blue")']);
    });

    test('an edit that lands while a batch runs is run afterwards, with its final text', async () => {
        const runs: string[] = [];
        const { notebook, editor } = openNotebook(NOTEBOOK);
        const scheduler = createScheduler(runs, 30);
        scheduler.runForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(150);
        runs.length = 0;

        const cell = notebook.cellAt(0);
        cell.document.setText('console.log("blu")', notebook);
        scheduler.runForNotebook(notebook as unknown as vscode.NotebookDocument);
        await wait(10);
        // Lands mid-batch: the pending guard turns this call away.
        cell.document.setText('console.log("blue")', notebook);
        scheduler.runForNotebook(notebook as unknown as vscode.NotebookDocument);
        await wait(150);

        assert.deepStrictEqual(runs, ['0:console.log("blu")', '0:console.log("blue")']);
    });
});
