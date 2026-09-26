import './tdd';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { InputCollapser } from '../../extension/inputCollapser';
import { WebnbTextReopener } from '../../extension/reopenAsNotebook';
import * as stub from './vscodeStub';
import { openNotebook, settle, wait, WORKSPACE_FOLDER } from './helpers';

suite('extension/reopenAsNotebook', () => {
    let reopener: WebnbTextReopener | undefined;
    setup(() => {
        stub.resetStub();
        stub.workspace.workspaceFolders = [WORKSPACE_FOLDER];
        // vscode.openWith opens a notebook tab next to the text tab.
        stub.testing.commandResults.set('vscode.openWith', (...args: unknown[]) => {
            const group = stub.window.tabGroups.all[0];
            group.tabs.push({ input: new stub.TabInputNotebook(args[0] as stub.Uri, 'web-notebook'), isActive: true, group });
            return undefined;
        });
    });
    teardown(() => reopener?.dispose());

    function textTab(path: string, active = true) {
        const group = { viewColumn: 1, isActive: true, tabs: [] as { input: unknown; isActive: boolean; group: unknown }[] };
        const tab = { input: new stub.TabInputText(stub.Uri.file(path)), isActive: active, group };
        group.tabs.push(tab);
        stub.window.tabGroups.all.push(group);
        return tab;
    }

    function openedWith(): unknown[][] {
        return stub.testing.executedCommands.filter(([id]) => id === 'vscode.openWith');
    }

    test('a .webnb shown as text is reopened as a notebook, closing that tab only', async () => {
        const tab = textTab('/ws/lesson.webnb');
        const other = textTab('/ws/index.html');
        reopener = new WebnbTextReopener();
        await settle();
        assert.strictEqual(openedWith().length, 1);
        assert.strictEqual((openedWith()[0][1] as stub.Uri).path, '/ws/lesson.webnb');
        assert.strictEqual(openedWith()[0][2], 'web-notebook');
        assert.deepStrictEqual(stub.testing.closedTabs, [tab]);
        assert.ok(!stub.testing.closedTabs.includes(other));
        assert.ok(!stub.testing.executedCommands.some(([id]) => id === 'workbench.action.closeActiveEditor'));
    });

    test('each file is taken over once, and only during the window after activation', async () => {
        reopener = new WebnbTextReopener(50);
        textTab('/ws/lesson.webnb');
        stub.testing.emitters.changeTabs.fire({});
        await settle();
        // The reader reopens it as text on purpose.
        textTab('/ws/lesson.webnb');
        stub.testing.emitters.changeTabs.fire({});
        await wait(80);
        textTab('/ws/later.webnb');
        stub.testing.emitters.changeTabs.fire({});
        await settle();
        assert.deepStrictEqual(openedWith().map(args => (args[1] as stub.Uri).path), ['/ws/lesson.webnb']);
    });

    test('when the notebook does not open, the text editor is kept', async () => {
        stub.testing.commandResults.set('vscode.openWith', () => undefined);
        textTab('/ws/lesson.webnb');
        reopener = new WebnbTextReopener();
        await settle();
        assert.strictEqual(openedWith().length, 1);
        assert.deepStrictEqual(stub.testing.closedTabs, []);
    });

    test('text editors with unsaved changes and files outside the workspace are left alone', async () => {
        const dirty = new stub.FakeTextDocument(stub.Uri.file('/ws/dirty.webnb'), 'webnb', 'x');
        dirty.isDirty = true;
        stub.workspace.textDocuments.push(dirty);
        textTab('/ws/dirty.webnb');
        const group = { viewColumn: 1, isActive: true, tabs: [] as { input: unknown; isActive: boolean; group: unknown }[] };
        group.tabs.push({ input: new stub.TabInputText(stub.Uri.parse('git://host/ws/lesson.webnb')), isActive: false, group });
        stub.window.tabGroups.all.push(group);
        reopener = new WebnbTextReopener();
        await settle();
        assert.strictEqual(openedWith().length, 0);
    });
});

suite('extension/inputCollapser', () => {
    let collapser: InputCollapser | undefined;
    setup(() => stub.resetStub());
    teardown(() => collapser?.dispose());

    const NOTEBOOK = '# A\n\n```{html hidecode}\n<b>x</b>\n```\n\n```{mcq}\nQ\n- [x] a\n```\n\n```{html}\n<i>y</i>\n```\n';

    function collapseCalls(): unknown[][] {
        return stub.testing.executedCommands.filter(([id]) => id === 'notebook.cell.collapseCellInput');
    }

    test('hidecode and widget cells are collapsed with explicit targets, once per session', async () => {
        const { notebook, editor } = openNotebook(NOTEBOOK);
        collapser = new InputCollapser(5);
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.deepStrictEqual(collapseCalls(), [[
            'notebook.cell.collapseCellInput',
            { ranges: [{ start: 1, end: 2 }, { start: 2, end: 3 }], document: notebook.uri }
        ]]);

        // Shown again (tab switch): the reader may have expanded them; leave them be.
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.strictEqual(collapseCalls().length, 1);

        // A new session (closed and reopened) collapses again.
        stub.testing.emitters.closeNotebookDocument.fire(notebook);
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.strictEqual(collapseCalls().length, 2);
    });

    test('an editor that has not laid out its cells yet is collapsed once it has', async () => {
        const { editor } = openNotebook(NOTEBOOK);
        editor.visibleRanges = [];
        collapser = new InputCollapser(5);
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.strictEqual(collapseCalls().length, 0);

        editor.visibleRanges = [new stub.NotebookRange(0, 4)];
        stub.testing.emitters.changeNotebookEditorVisibleRanges.fire({ notebookEditor: editor, visibleRanges: editor.visibleRanges });
        await wait(20);
        assert.strictEqual(collapseCalls().length, 1);
    });

    test('nothing is collapsed while the notebook is off screen; it is tried again when shown', async () => {
        const { editor } = openNotebook(NOTEBOOK);
        collapser = new InputCollapser(5);
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        stub.window.visibleNotebookEditors = [];
        await wait(20);
        assert.strictEqual(collapseCalls().length, 0);

        stub.window.visibleNotebookEditors = [editor];
        collapser.collapseForEditor(editor as unknown as vscode.NotebookEditor);
        await wait(20);
        assert.strictEqual(collapseCalls().length, 1);
    });
});
