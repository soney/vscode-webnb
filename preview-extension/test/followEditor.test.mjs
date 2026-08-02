/**
 * An open preview should move to whichever .webnb the author switches to. The
 * failure modes are quiet ones -- a preview left showing the previous notebook,
 * or a second panel piling up beside it -- so the rebinding is pinned here
 * rather than clicked through by hand.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPreviewManager } from './harness.mjs';

const { WebnbPreviewManager, vscode } = await loadPreviewManager();

const NOTEBOOK = '# Title\n\nA paragraph.\n';

function document(filePath, text = NOTEBOOK) {
    return {
        uri: vscode.Uri.file(filePath),
        getText: () => text,
        lineCount: text.split('\n').length
    };
}

function editorFor(doc) {
    return { document: doc, viewColumn: 1, visibleRanges: [], selection: { active: { line: 0 } } };
}

/** A manager with one workspace folder and nothing open. */
function newManager() {
    vscode.reset();
    vscode.state.workspaceFolders = [{ uri: vscode.Uri.file('/course'), name: 'course', index: 0 }];
    return new WebnbPreviewManager(vscode.Uri.file('/ext'));
}

/** Open a preview for a document and let its page report in. */
function openPreview(manager, doc) {
    manager.show(doc, vscode.ViewColumn.Beside);
    const panel = vscode.state.panels[vscode.state.panels.length - 1];
    panel.webview.send({ type: 'ready' });
    return panel;
}

function lastInit(panel) {
    return panel.webview.messages.filter(message => message.type === 'init').pop();
}

function boundTo(panel) {
    return lastInit(panel)?.documentKey;
}

test('the preview follows the author to another notebook', () => {
    const manager = newManager();
    const first = document('/course/one.webnb');
    const second = document('/course/two.webnb');

    const panel = openPreview(manager, first);
    assert.equal(boundTo(panel), first.uri.toString());

    vscode.events.activeTextEditor.fire(editorFor(second));

    assert.equal(vscode.state.panels.length, 1, 'no second panel');
    assert.equal(boundTo(panel), second.uri.toString());
    assert.match(panel.title, /two\.webnb$/);
    assert.equal(panel.webview.htmlLoads, 1, 'the page is re-used, not reloaded');

    manager.dispose();
});

test('edits to the notebook it moved to reach the preview', () => {
    const manager = newManager();
    const first = document('/course/one.webnb');
    const second = document('/course/two.webnb');

    const panel = openPreview(manager, first);
    vscode.events.activeTextEditor.fire(editorFor(second));

    const edited = document('/course/two.webnb', '# Edited\n\nNew text.\n');
    vscode.events.textDocumentChanged.fire({ document: edited, contentChanges: [{}] });

    return new Promise(resolve => setTimeout(resolve, 300)).then(() => {
        const update = panel.webview.messages.filter(message => message.type === 'update').pop();
        assert.ok(update, 'the edit produced an update');
        assert.ok(
            update.cells.some(cell => cell.value.includes('Edited')),
            'the update carries the new text'
        );
        manager.dispose();
    });
});

test('a file that is not a notebook leaves the preview alone', () => {
    const manager = newManager();
    const notebook = document('/course/one.webnb');
    const panel = openPreview(manager, notebook);

    vscode.events.activeTextEditor.fire(editorFor(document('/course/notes.md')));
    vscode.events.activeTextEditor.fire(undefined); // focus moved into the preview

    assert.equal(boundTo(panel), notebook.uri.toString());
    manager.dispose();
});

test('a notebook with its own preview keeps it', () => {
    const manager = newManager();
    const first = document('/course/one.webnb');
    const second = document('/course/two.webnb');

    const firstPanel = openPreview(manager, first);
    const secondPanel = openPreview(manager, second);

    vscode.events.activeTextEditor.fire(editorFor(first));

    assert.equal(boundTo(firstPanel), first.uri.toString());
    assert.equal(boundTo(secondPanel), second.uri.toString(), 'the other preview did not move');
    manager.dispose();
});

test('a visible preview follows before a buried one', () => {
    const manager = newManager();
    const buried = openPreview(manager, document('/course/one.webnb'));
    const visible = openPreview(manager, document('/course/two.webnb'));
    buried.setViewState({ visible: false, active: false });

    const third = document('/course/three.webnb');
    vscode.events.activeTextEditor.fire(editorFor(third));

    assert.equal(boundTo(visible), third.uri.toString());
    assert.equal(boundTo(buried), vscode.Uri.file('/course/one.webnb').toString());
    manager.dispose();
});

test('followActiveEditor off pins the preview to the notebook it was opened for', () => {
    const manager = newManager();
    vscode.state.settings['webnbPreview.followActiveEditor'] = false;
    const notebook = document('/course/one.webnb');
    const panel = openPreview(manager, notebook);

    vscode.events.activeTextEditor.fire(editorFor(document('/course/two.webnb')));

    assert.equal(boundTo(panel), notebook.uri.toString());
    manager.dispose();
});

/**
 * Relative images and files resolve against the notebook's own folder, and a
 * webview may only load from folders it was given. One outside the workspace is
 * a folder the page has never been allowed to read, which only a reload can fix.
 */
test('a notebook outside the workspace reloads the page with its folder allowed', () => {
    const manager = newManager();
    const panel = openPreview(manager, document('/course/one.webnb'));
    assert.equal(panel.webview.htmlLoads, 1);

    const outside = document('/elsewhere/three.webnb');
    vscode.events.activeTextEditor.fire(editorFor(outside));

    assert.equal(panel.webview.htmlLoads, 2, 'the page reloaded');
    assert.equal(boundTo(panel), vscode.Uri.file('/course/one.webnb').toString(), 'no init before the page is up');

    panel.webview.send({ type: 'ready' });

    assert.equal(boundTo(panel), outside.uri.toString());
    assert.ok(
        panel.webview.options.localResourceRoots.some(root => root.path === '/elsewhere'),
        'the new folder is loadable'
    );
    manager.dispose();
});
