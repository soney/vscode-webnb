import './tdd';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DefaultCapture } from '../../extension/defaultCapture';
import { WebNotebookKernel } from '../../extension/webnbProvider';
import { getAddonContent } from '../../shared/addons';
import type { Addon } from '../../shared/protocol';
import * as stub from './vscodeStub';
import { openNotebook, saveNotebook, settle, wait, WORKSPACE_FOLDER } from './helpers';

function addonsOf(cell: stub.FakeCell): Addon[] {
    return (cell.metadata.addons as Addon[] | undefined) ?? [];
}

suite('extension/defaultCapture and the kernel', () => {
    const disposables: vscode.Disposable[] = [];
    setup(() => {
        stub.resetStub();
        stub.workspace.workspaceFolders = [WORKSPACE_FOLDER];
    });
    teardown(() => {
        disposables.splice(0).forEach(disposable => disposable.dispose());
    });

    /** A kernel whose controller is already this notebook's selected kernel. */
    function createKernel(notebook?: stub.FakeNotebook): WebNotebookKernel {
        const kernel = new WebNotebookKernel('oney.web-notebook');
        disposables.push(kernel);
        if (notebook) {
            const controller = (kernel as unknown as { _controller: { fireSelected(notebook: unknown, selected: boolean): void } })._controller;
            controller.fireSelected(notebook, true);
        }
        return kernel;
    }

    suite('+default capture', () => {
        test('an empty starter is captured as an empty +default on the first edit, and stays empty', async () => {
            const { notebook } = openNotebook('```{html}\n```\n');
            disposables.push(new DefaultCapture());
            const cell = notebook.cellAt(0);
            cell.document.setText('<strong>hello</strong>', notebook);
            await settle();
            assert.deepStrictEqual(addonsOf(cell), [{ type: 'default', content: '' }]);

            // Running the cell (the kernel used to fill an empty +default here) leaves it empty.
            const kernel = createKernel(notebook);
            await kernel.executeHandler([cell as unknown as vscode.NotebookCell], notebook as unknown as vscode.NotebookDocument, undefined as never);
            assert.deepStrictEqual(addonsOf(cell), [{ type: 'default', content: '' }]);
            assert.ok(saveNotebook(notebook).endsWith('```{html}\n<strong>hello</strong>\n```\n```+default\n```\n'));
        });

        test('a notebook reopened with an empty +default keeps it empty through edits and runs', async () => {
            const { notebook } = openNotebook('```{html}\n<b>attempt</b>\n```\n```+default\n```\n');
            disposables.push(new DefaultCapture());
            const cell = notebook.cellAt(0);
            cell.document.setText('<b>another attempt</b>', notebook);
            const kernel = createKernel(notebook);
            await kernel.executeHandler([cell as unknown as vscode.NotebookCell], notebook as unknown as vscode.NotebookDocument, undefined as never);
            await settle();
            assert.strictEqual(getAddonContent(addonsOf(cell), 'default'), '');
        });

        test('an author-written +default is never rewritten', async () => {
            const { notebook } = openNotebook('```{javascript}\nlet x = 1;\n```\n```+default\n// starter\n```\n');
            disposables.push(new DefaultCapture());
            const cell = notebook.cellAt(0);
            cell.document.setText('let x = 2;', notebook);
            await settle();
            assert.strictEqual(getAddonContent(addonsOf(cell), 'default'), '// starter');
        });

        test('Reset code restores an empty starter', async () => {
            const { notebook } = openNotebook('```{html}\n<b>attempt</b>\n```\n```+default\n```\n');
            createKernel(notebook);
            const cell = notebook.cellAt(0);
            stub.testing.emitters.rendererMessage.fire({
                editor: stub.window.activeNotebookEditor,
                message: { type: 'webnb.resetCellSource', cellUri: cell.document.uri.toString() }
            });
            await settle();
            assert.strictEqual(cell.document.getText(), '');
        });
    });

    suite('renderer addon writes', () => {
        test('only JSON +selection / +history reach the cell', async () => {
            const { notebook, editor } = openNotebook('```{mcq}\nQ\n- [x] a\n```\n');
            createKernel(notebook);
            const cell = notebook.cellAt(0);
            const send = async (addonType: string, content: string) => {
                stub.testing.emitters.rendererMessage.fire({
                    editor, message: { type: 'webnb.upsertCellAddon', cellUri: cell.document.uri.toString(), addonType, content }
                });
                await settle();
            };
            await send('test', '{}');
            await send('selection', 'not json');
            await send('selection', '```\n');
            await send('history', '{"commands":["ls"]}');
            await send('selection', '{"selected":[0]}');
            assert.deepStrictEqual(addonsOf(cell).map(addon => addon.type).sort(), ['history', 'selection']);
            assert.strictEqual(getAddonContent(addonsOf(cell), 'selection'), '{"selected":[0]}');
        });
    });

    suite('background runs never move focus', () => {
        test('a checklist refresh in a notebook whose kernel is selected shows nothing and selects nothing', async () => {
            const { notebook, editor } = openNotebook('```{external}\npath: index.html\n```\n');
            createKernel(notebook);
            // The learner is typing in a text editor beside the notebook.
            stub.window.activeNotebookEditor = undefined;
            let shown = 0;
            const show = stub.window.showNotebookDocument;
            stub.window.showNotebookDocument = async (...args) => { shown++; return show(...args); };
            try {
                const cell = notebook.cellAt(0);
                stub.testing.executedCommands.length = 0;
                stub.testing.emitters.rendererMessage.fire({
                    editor, message: { type: 'webnb.refreshCell', cellUri: cell.document.uri.toString() }
                });
                await settle();
                assert.strictEqual(shown, 0);
                assert.ok(!stub.testing.executedCommands.some(([id]) => id === '_notebook.selectKernel'));
                assert.strictEqual(cell.outputs.length, 1);
            } finally {
                stub.window.showNotebookDocument = show;
            }
        });

        test('a first selection for a notebook that is not active waits instead of taking focus', async () => {
            const { notebook } = openNotebook('```{javascript autorun}\nx\n```\n');
            stub.window.activeNotebookEditor = undefined;
            createKernel();
            await wait(50);
            assert.ok(!stub.testing.executedCommands.some(([id]) => id === '_notebook.selectKernel'));
            assert.strictEqual(notebook.cellAt(0).outputs.length, 0);
        });

        test('a refresh dropped while the notebook is hidden runs again when it is shown', async () => {
            const { notebook, editor } = openNotebook('```{external}\npath: index.html\n```\n');
            createKernel(notebook);
            const cell = notebook.cellAt(0);
            await wait(20);
            assert.strictEqual(cell.outputs.length, 1, 'the checklist runs on open');
            cell.outputs = [new stub.NotebookCellOutput([])];

            stub.window.visibleNotebookEditors = [];
            stub.testing.emitters.rendererMessage.fire({
                editor, message: { type: 'webnb.refreshCell', cellUri: cell.document.uri.toString() }
            });
            await settle();
            assert.strictEqual(cell.outputs[0].items.length, 0, 'nothing can run while hidden');

            stub.window.visibleNotebookEditors = [editor];
            stub.testing.emitters.changeVisibleNotebookEditors.fire([editor]);
            await settle(10);
            assert.strictEqual(cell.outputs[0].items.length, 1, 're-run once visible');
        });
    });
});
