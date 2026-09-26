/**
 * A half-typed notebook is malformed most of the time. The parser shows a
 * malformed block as text and says why; the preview has to pass that on, in
 * the banner above the cells, and clear it once the document is fixed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPreviewManager } from './harness.mjs';

const { WebnbPreviewManager, vscode } = await loadPreviewManager();

function doc(text) {
    return { uri: vscode.Uri.file('/course/one.webnb'), getText: () => text, lineCount: text.split('\n').length };
}

function lastParseError(panel) {
    return panel.webview.messages.filter(message => message.type === 'parseError').pop();
}

test('a malformed block is rendered as text and its warning shown', async () => {
    vscode.reset();
    vscode.state.workspaceFolders = [{ uri: vscode.Uri.file('/course'), name: 'course', index: 0 }];
    const manager = new WebnbPreviewManager(vscode.Uri.file('/ext'));

    // An addon block with no code cell above it.
    const broken = doc('# Title\n\n```+test\nwrap(1).should("equal", 1);\n```\n');
    manager.show(broken, vscode.ViewColumn.Beside);
    const panel = vscode.state.panels[0];
    panel.webview.send({ type: 'ready' });

    const init = panel.webview.messages.find(message => message.type === 'init');
    assert.ok(init.cells.length > 0, 'the document still renders');
    assert.match(lastParseError(panel)?.message ?? '', /line 3: .*shown as text/);

    // Fixed: the banner clears on the next update.
    const fixed = doc('# Title\n\n```{javascript}\nconsole.log(1);\n```\n```+test\nwrap(1).should("equal", 1);\n```\n');
    vscode.events.textDocumentChanged.fire({ document: fixed, contentChanges: [{}] });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(lastParseError(panel)?.message, undefined);
    manager.dispose();
});
