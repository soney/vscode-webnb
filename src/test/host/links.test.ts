import './tdd';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate as activateLinks } from '../../extension/notebookLinkNavigator';
import { isRealPathInside, isUriInside } from '../../extension/workspaceContainment';
import { snapshotWorkspaceFiles } from '../../extension/workspaceSnapshots';
import * as stub from './vscodeStub';
import { openNotebook, settle } from './helpers';

suite('extension/workspaceContainment', () => {
    let root: string;
    let outside: string;
    suiteSetup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'webnb-ws-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'webnb-out-'));
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
        fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
        fs.symlinkSync(outside, path.join(root, 'escape'));
        fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'alias.html'));
    });
    suiteTeardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    setup(() => stub.resetStub());

    test('path containment', () => {
        const base = stub.Uri.file('/ws/course');
        assert.strictEqual(isUriInside(base as unknown as vscode.Uri, stub.Uri.file('/ws/course/a/b.webnb') as unknown as vscode.Uri), true);
        assert.strictEqual(isUriInside(base as unknown as vscode.Uri, stub.Uri.file('/ws/course-other/b.webnb') as unknown as vscode.Uri), false);
        assert.strictEqual(isUriInside(base as unknown as vscode.Uri, stub.Uri.file('/etc/b.webnb') as unknown as vscode.Uri), false);
    });

    test('real-path containment follows symlinks', async () => {
        const rootUri = stub.Uri.file(root) as unknown as vscode.Uri;
        const inside = (relative: string) => isRealPathInside(rootUri, stub.Uri.file(path.join(root, relative)) as unknown as vscode.Uri);
        assert.strictEqual(await inside('index.html'), true);
        assert.strictEqual(await inside('alias.html'), true, 'a symlink that stays inside is fine');
        assert.strictEqual(await inside('escape/secret.txt'), false);
        assert.strictEqual(await inside('missing.html'), true, 'a missing file is left to the caller to report');
    });

    test('snapshots never read through a symlink out of the workspace', async () => {
        stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(root), name: 'ws', index: 0 }];
        stub.testing.fs.stat = async uri => ({ type: stub.FileType.File, size: fs.statSync(uri.path).size });
        stub.testing.fs.readFile = async uri => fs.readFileSync(uri.path);
        const { notebook } = openNotebook('```{external}\npath: index.html\npath: escape/secret.txt\n```\n',
            { uri: stub.Uri.file(path.join(root, 'lesson.webnb')) });
        const cell = notebook.cellAt(0);
        const snapshots = await snapshotWorkspaceFiles(cell as unknown as vscode.NotebookCell, [], 'external', cell.document.getText());
        assert.strictEqual(snapshots['index.html'].content, '<h1>ok</h1>');
        assert.strictEqual(snapshots['escape/secret.txt'].exists, false);
        assert.strictEqual(snapshots['escape/secret.txt'].content, undefined);
    });

    test('with no folder open, paths resolve next to the notebook', async () => {
        stub.testing.fs.stat = async uri => ({ type: stub.FileType.File, size: fs.statSync(uri.path).size });
        stub.testing.fs.readFile = async uri => fs.readFileSync(uri.path);
        const { notebook } = openNotebook('```{external}\npath: index.html\n```\n', { uri: stub.Uri.file(path.join(root, 'lesson.webnb')) });
        const cell = notebook.cellAt(0);
        const snapshots = await snapshotWorkspaceFiles(cell as unknown as vscode.NotebookCell, [], 'external', cell.document.getText());
        assert.strictEqual(snapshots['index.html'].content, '<h1>ok</h1>');
    });
});

suite('extension/notebookLinkNavigator', () => {
    // A web-build workspace: no real files behind these paths, so no real-path check.
    const web = (location: string) => stub.Uri.parse(`vscode-test-web://mount${location}`);
    let subscriptions: vscode.Disposable[] = [];
    setup(() => {
        stub.resetStub();
        stub.workspace.workspaceFolders = [{ uri: web('/ws'), name: 'ws', index: 0 }];
        subscriptions = [];
        activateLinks({ subscriptions } as unknown as vscode.ExtensionContext);
    });
    teardown(() => subscriptions.forEach(subscription => subscription.dispose()));

    test('the link handler is switched on for Web Notebooks only, answering the asking editor', async () => {
        const { editor } = openNotebook('# A\n', { uri: web('/ws/lesson.webnb') });
        const jupyter = new stub.FakeNotebookEditor(new stub.FakeNotebook(web('/ws/a.ipynb'), [], 'jupyter-notebook'));
        stub.testing.emitters.rendererMessage.fire({ editor, message: { type: 'webnb.linkHandlerHello' } });
        stub.testing.emitters.rendererMessage.fire({ editor: jupyter, message: { type: 'webnb.linkHandlerHello' } });
        await settle();
        assert.deepStrictEqual(stub.testing.postedRendererMessages, [
            { message: { type: 'webnb.linkHandlerConfig', enabled: true }, editor },
            { message: { type: 'webnb.linkHandlerConfig', enabled: false }, editor: jupyter }
        ]);
    });

    test('a link request from another notebook type is ignored', async () => {
        const jupyter = new stub.FakeNotebookEditor(new stub.FakeNotebook(web('/ws/a.ipynb'), [], 'jupyter-notebook'));
        stub.testing.emitters.rendererMessage.fire({
            editor: jupyter, message: { type: 'webnb.openNotebookLink', href: '#intro', path: '', section: 'intro' }
        });
        await settle();
        assert.deepStrictEqual(jupyter.revealed, []);
        assert.strictEqual(stub.testing.messages.length, 0);
    });

    test('a relative link may not leave the workspace folder', async () => {
        const { editor } = openNotebook('# A\n', { uri: web('/ws/m1/lesson.webnb') });
        stub.testing.fs.stat = async () => ({ type: stub.FileType.File, size: 1 });
        stub.testing.emitters.rendererMessage.fire({
            editor, message: { type: 'webnb.openNotebookLink', href: '../../elsewhere/x.webnb', path: '../../elsewhere/x.webnb', section: '' }
        });
        await settle();
        assert.ok(stub.testing.messages.some(entry => entry.message.includes('points outside this workspace')));
        assert.strictEqual(stub.workspace.notebookDocuments.length, 1);
    });

    test('a link inside the workspace opens the notebook', async () => {
        const { editor } = openNotebook('# A\n', { uri: web('/ws/m1/lesson.webnb') });
        stub.testing.fs.stat = async () => ({ type: stub.FileType.File, size: 1 });
        stub.testing.emitters.rendererMessage.fire({
            editor, message: { type: 'webnb.openNotebookLink', href: '../m2/next.webnb', path: '../m2/next.webnb', section: '' }
        });
        await settle();
        assert.ok(stub.workspace.notebookDocuments.some(notebook => notebook.uri.path === '/ws/m2/next.webnb'));
    });
});
