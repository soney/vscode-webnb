/**
 * Clicking the preview puts the editor's cursor on the matching source line, so
 * the offsets behind that have to be right. An off-by-one here is not a crash,
 * it is a preview that quietly sends you to the wrong paragraph, which is why
 * these are pinned rather than eyeballed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findNotebooks, loadHarness, notebooksDir, readNotebook } from './harness.mjs';

const { blockSourceLines, parseMarkdown, computeCellSpans, CODE } = await loadHarness();

test('each block reports the line it starts on', () => {
    const source = [
        '# Title',            // 0
        '',                   // 1
        'First paragraph.',   // 2
        '',                   // 3
        'Second paragraph.'   // 4
    ].join('\n');

    assert.deepEqual(blockSourceLines(source), [0, 2, 4]);
});

test('multi-line blocks push the ones after them down', () => {
    const source = [
        'A paragraph that',   // 0
        'wraps over lines.',  // 1
        '',                   // 2
        '- item one',         // 3
        '- item two',         // 4
        '',                   // 5
        'Closing.'            // 6
    ].join('\n');

    // The list is one block, so the closing paragraph is at 6, not 4.
    assert.deepEqual(blockSourceLines(source), [0, 3, 6]);
});

test('a fenced block inside prose counts its own lines', () => {
    const source = [
        'Before.',      // 0
        '',             // 1
        '```js',        // 2
        'const x = 1;', // 3
        '```',          // 4
        '',             // 5
        'After.'        // 6
    ].join('\n');

    assert.deepEqual(blockSourceLines(source), [0, 2, 6]);
});

test('leading blank lines do not shift the first block', () => {
    assert.deepEqual(blockSourceLines('\n\nOnly paragraph.'), [2]);
});

test('an empty source has no blocks', () => {
    assert.deepEqual(blockSourceLines(''), []);
});

/**
 * The end-to-end arithmetic: a block's absolute line is the cell's start plus
 * its offset, and that has to land inside the cell's own span for every markup
 * cell in the course -- otherwise a click leaves the cell it came from.
 */
test('every markup block resolves to a line inside its own cell', async (t) => {
    const files = await findNotebooks(notebooksDir);
    if (files.length === 0) {
        t.skip(`no course notebooks at ${notebooksDir} (set WEBNB_NOTEBOOKS to point at some)`);
        return;
    }

    let blocks = 0;
    for (const file of files) {
        const text = await readNotebook(file);
        const cells = parseMarkdown(text);
        const spans = computeCellSpans(text, cells.map(cell => ({
            kind: cell.kind === CODE ? 'code' : 'markup',
            content: cell.content,
            rawCode: cell.rawCode,
            indentation: cell.indentation
        })));

        cells.forEach((cell, index) => {
            if (cell.kind === CODE || cell.rawCode !== undefined) {
                return; // fenced cells map per line, not per block
            }
            const { startLine, endLine } = spans[index];
            for (const offset of blockSourceLines(cell.content)) {
                const line = startLine + offset;
                assert.ok(
                    line >= startLine && line <= endLine,
                    `${file.split('/').pop()}: block at ${line} escapes its cell (${startLine}-${endLine})`
                );
                blocks++;
            }
        });
    }
    console.log(`  ${blocks} markup blocks resolve inside their own cell`);
});
