/**
 * Links clicked in the preview's markup mean what they mean in the notebook
 * (src/shared/notebookLinks.ts): another notebook opens at its section,
 * `#section` scrolls within this one, `%20` and `../` resolve, and anything
 * missing is reported rather than ignored. Also pins the two reconciling and
 * page rules that go with them: an `id=` cell edited in place gets a fresh
 * view, and the page lets inline event handlers run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHarness, loadPreviewManager } from './harness.mjs';

const { WebnbPreviewManager, vscode } = await loadPreviewManager();
const { parseDocumentCells } = await loadHarness();

const SOURCE = [
    '# Linking',               // 0
    '',                        // 1
    'See [Beta](#beta).',      // 2
    '',                        // 3
    '```{javascript}',         // 4
    'console.log(1);',         // 5
    '```',                     // 6
    '',                        // 7
    '## Beta',                 // 8
    '',                        // 9
    'The section.'             // 10
].join('\n');

const TARGET = [
    '# Target',      // 0
    '',              // 1
    '```{html}',     // 2
    '<p>hi</p>',     // 3
    '```',           // 4
    '',              // 5
    '## Alpha',      // 6
    '',              // 7
    'Alpha text.'    // 8
].join('\n');

function doc(filePath, text) {
    return {
        uri: vscode.Uri.file(filePath),
        getText: () => text,
        lineCount: text.split('\n').length
    };
}

/** A preview of /course/sub/one.webnb, its editor visible beside it. */
function setup() {
    vscode.reset();
    vscode.state.workspaceFolders = [{ uri: vscode.Uri.file('/course'), name: 'course', index: 0 }];
    vscode.state.files = {
        '/course/sub/one.webnb': SOURCE,
        '/course/sub/my notebook.webnb': TARGET,
        '/course/top.webnb': TARGET,
        '/course/sub/notes.txt': 'notes',
        '/course/sub/folder': null
    };
    const source = doc('/course/sub/one.webnb', SOURCE);
    const reveals = [];
    vscode.state.visibleTextEditors = [{
        document: source,
        viewColumn: 1,
        visibleRanges: [],
        selection: { active: { line: 0 } },
        revealRange: range => reveals.push(range.startLine)
    }];
    const manager = new WebnbPreviewManager(vscode.Uri.file('/ext'));
    manager.show(source, vscode.ViewColumn.Beside);
    const panel = vscode.state.panels[vscode.state.panels.length - 1];
    panel.webview.send({ type: 'ready' });
    return { manager, panel, reveals };
}

/** Click a link in the page and let the host's async handling finish. */
async function click(panel, href) {
    panel.webview.send({ type: 'openLink', href });
    await new Promise(resolve => setTimeout(resolve, 20));
}

function lastOpen() {
    return vscode.state.commands.filter(call => call.command === 'vscode.openWith' || call.command === 'vscode.open').pop();
}

test('a link to another notebook opens its source at the section', async () => {
    const { manager, panel } = setup();
    await click(panel, 'my%20notebook.webnb#alpha');

    const open = lastOpen();
    assert.equal(open?.command, 'vscode.openWith');
    assert.equal(open.args[0].path, '/course/sub/my notebook.webnb', '%20 decoded, relative to the linking notebook');
    assert.equal(open.args[1], 'default', 'opened as text, not as a notebook');
    assert.equal(open.args[2].selection.startLine, 6, 'the cursor lands on the Alpha heading cell');
    assert.deepEqual(vscode.state.warnings, []);
    manager.dispose();
});

test('../ and a leading / resolve like the notebook resolves them', async () => {
    const { manager, panel } = setup();
    await click(panel, '../top.webnb');
    assert.equal(lastOpen()?.args[0].path, '/course/top.webnb');

    await click(panel, '/top.webnb#alpha');
    assert.equal(lastOpen()?.args[0].path, '/course/top.webnb', 'a leading / is the workspace root');
    assert.equal(lastOpen().args[2].selection.startLine, 6);
    assert.deepEqual(vscode.state.warnings, []);
    manager.dispose();
});

test('a #section link scrolls this preview and its editor', async () => {
    const { manager, panel, reveals } = setup();
    await click(panel, '#beta');

    const shown = panel.webview.messages.filter(message => message.type === 'showLine').pop();
    assert.equal(shown?.line, 8, 'the Beta cell starts on line 8');
    assert.deepEqual(reveals, [8], 'the source editor follows');
    assert.equal(lastOpen(), undefined, 'nothing else opens');
    manager.dispose();
});

test('missing notebooks, sections, and files are reported, not ignored', async () => {
    const { manager, panel } = setup();
    await click(panel, 'missing.webnb');
    await click(panel, '#no-such-section');
    await click(panel, 'my%20notebook.webnb#no-such-section');
    await click(panel, 'missing.txt');

    assert.deepEqual(vscode.state.warnings, [
        'There is no notebook at "missing.webnb".',
        'This notebook has no section called "#no-such-section".',
        '"my notebook.webnb" has no section called "#no-such-section".',
        'There is no file at "missing.txt".'
    ]);
    assert.equal(lastOpen()?.args[0].path, '/course/sub/my notebook.webnb', 'a missing section still opens the notebook');
    manager.dispose();
});

test('a link to a file opens it beside the preview; a folder is revealed', async () => {
    const { manager, panel } = setup();
    await click(panel, 'notes.txt#L2');
    const open = lastOpen();
    assert.equal(open?.command, 'vscode.open');
    assert.equal(open.args[0].path, '/course/sub/notes.txt', 'the fragment is not part of the path');

    await click(panel, 'folder');
    assert.equal(vscode.state.commands.pop()?.command, 'revealInExplorer');
    manager.dispose();
});

test('the page lets inline event handlers run', () => {
    const { manager, panel } = setup();
    const csp = panel.webview.html.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? '';
    const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src')) ?? '';
    assert.match(scriptSrc, /'unsafe-inline'/);
    assert.doesNotMatch(scriptSrc, /'nonce-/, 'a nonce would switch unsafe-inline off');
    manager.dispose();
});

test('editing the body of an id= cell makes it a new cell to the page', () => {
    const before = parseDocumentCells('```{javascript id=counter}\nlet n = 1;\n```\n');
    const after = parseDocumentCells('```{javascript id=counter}\nlet n = 2;\n```\n');
    assert.equal(before[0].stableKey, after[0].stableKey, 'the id still identifies the cell');
    assert.notEqual(before[0].contentKey, after[0].contentKey, 'but its view is rebuilt');

    const moved = parseDocumentCells('Intro.\n\n```{javascript id=counter}\nlet n = 1;\n```\n');
    assert.equal(moved[1].contentKey, before[0].contentKey, 'moving an unchanged cell keeps its view');
});
