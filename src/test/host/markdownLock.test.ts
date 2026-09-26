import './tdd';
import * as assert from 'assert';
import { MarkdownLock } from '../../extension/markdownLock';
import * as stub from './vscodeStub';
import { openNotebook, settle, wait } from './helpers';

suite('extension/markdownLock', () => {
    let lock: MarkdownLock | undefined;
    setup(() => {
        stub.resetStub();
        stub.testing.config.values.globalValue['webnb.lockMarkdown'] = true;
    });
    teardown(() => lock?.dispose());

    test('a Replace All across many locked cells is undone in every cell', async () => {
        const text = Array.from({ length: 10 }, (_, index) => `Lesson step ${index}`).join('\n\n') + '\n';
        const { notebook } = openNotebook(text);
        lock = new MarkdownLock({ debounceMs: 10, burstWindowMs: 200 });
        for (const cell of notebook.getCells()) {
            cell.document.setText(cell.document.getText().replace('step', 'STEP'), notebook);
        }
        await wait(60);
        await settle();
        assert.deepStrictEqual(notebook.getCells().filter(cell => cell.document.getText().includes('STEP')).length, 0);
    });

    test('an edit that keeps coming back is fought at a bounded rate and never accepted', async () => {
        const { notebook } = openNotebook('Lesson text\n');
        lock = new MarkdownLock({ debounceMs: 5, maxRevertsPerWindow: 2, burstWindowMs: 80 });
        const cell = notebook.cellAt(0);
        // Another writer re-applies its edit whenever the lock restores the text.
        let fights = 0;
        const off = stub.testing.emitters.changeTextDocument.event(() => {
            if (cell.document.getText() === 'Lesson text' && fights < 6) {
                fights++;
                setTimeout(() => cell.document.setText('Edited', notebook), 1);
            }
        });
        cell.document.setText('Edited', notebook);
        await wait(500);
        off.dispose();
        await wait(150);
        await settle();
        assert.strictEqual(cell.document.getText(), 'Lesson text');
    });
});
