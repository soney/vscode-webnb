import './tdd';
import * as assert from 'assert';
import { NotebookRestorer } from '../../extension/restoreNotebook';
import type { Addon } from '../../shared/protocol';
import * as stub from './vscodeStub';
import { openNotebook, saveNotebook, settle } from './helpers';

const NOTEBOOK = [
    '```{html}',
    '<b>attempt</b>',
    '```',
    '```+default',
    '```',
    '',
    '```{javascript autorun}',
    'console.log("demo")',
    '```',
    '',
    '```{mcq}',
    'Q',
    '- [x] a',
    '```',
    '```+selection',
    '{"selected":[0]}',
    '```',
    '',
    '```{javascript}',
    'let edited = true;',
    '```',
    '',
    '```+history',
    '{"commands":["ls"]}',
    '```',
    '```+test',
    'assert(1)',
    '```',
    ''
].join('\n');

suite('extension/restoreNotebook', () => {
    let restorer: NotebookRestorer | undefined;
    let runs: number[];
    let cleared: stub.FakeCell[];
    setup(() => {
        stub.resetStub();
        runs = [];
        cleared = [];
        restorer = new NotebookRestorer({
            async executeRanges(_notebook, ranges) {
                runs.push(...ranges.map(range => range.start));
                return true;
            },
            async clearOutputs(cells) {
                cleared.push(...cells as unknown as stub.FakeCell[]);
            }
        });
    });
    teardown(() => restorer?.dispose());

    test('asks modally, restores empty starters, drops +selection and +history with their gaps', async () => {
        const { notebook } = openNotebook(NOTEBOOK);
        notebook.getCells().forEach(cell => { cell.outputs = [new stub.NotebookCellOutput([])]; });
        let modal: unknown;
        stub.testing.answer = message => (message.startsWith('Restore this notebook') ? 'Restore' : undefined);
        const warning = stub.window.showWarningMessage;
        stub.window.showWarningMessage = (message: string, ...rest: unknown[]) => {
            modal ??= rest[0];
            return warning(message, ...rest);
        };
        try {
            await stub.testing.commandHandlers.get('webnb.restoreNotebook')!();
            await settle();
        } finally {
            stub.window.showWarningMessage = warning;
        }

        assert.deepStrictEqual(modal, { modal: true });
        const cells = notebook.getCells();
        assert.strictEqual(cells[0].document.getText(), '', 'the empty starter comes back');
        assert.deepStrictEqual((cells[2].metadata.addons as Addon[]).map(addon => addon.type), []);
        assert.deepStrictEqual((cells[3].metadata.addons as Addon[]).map(addon => addon.type), ['test']);
        // The +test addon keeps the gap in front of it, not +history's.
        assert.ok(saveNotebook(notebook).endsWith('```{javascript}\nlet edited = true;\n```\n```+test\nassert(1)\n```\n'));
        // The autorun demo and the widget are re-run; the other outputs are dropped.
        assert.deepStrictEqual(runs, [1, 2]);
        assert.deepStrictEqual(cleared.map(cell => cell.index), [0, 3]);
    });

    test('restores the notebook it was invoked on, not the one active when the prompt is answered', async () => {
        const { notebook: first } = openNotebook(NOTEBOOK, { uri: stub.Uri.file('/ws/first.webnb') });
        const { notebook: second } = openNotebook(NOTEBOOK, { uri: stub.Uri.file('/ws/second.webnb') });
        stub.testing.answer = message => {
            if (message.startsWith('Restore this notebook')) {
                // The reader switches notebooks while the prompt is up.
                stub.window.activeNotebookEditor = stub.window.visibleNotebookEditors.find(editor => editor.notebook === second);
                return 'Restore';
            }
            return undefined;
        };
        await stub.testing.commandHandlers.get('webnb.restoreNotebook')!(first.uri);
        await settle();
        assert.strictEqual(first.cellAt(0).document.getText(), '');
        assert.strictEqual(second.cellAt(0).document.getText(), '<b>attempt</b>');
    });

    test('dismissing the prompt changes nothing', async () => {
        const { notebook } = openNotebook(NOTEBOOK);
        await stub.testing.commandHandlers.get('webnb.restoreNotebook')!();
        await settle();
        assert.strictEqual(notebook.cellAt(0).document.getText(), '<b>attempt</b>');
        assert.strictEqual(stub.testing.appliedEdits.length, 0);
    });
});
