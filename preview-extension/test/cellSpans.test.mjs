/**
 * The span mapper is the one piece of this extension that infers something the
 * notebook parser does not report, so it is checked against every real notebook
 * rather than a handful of fixtures: if a future parser change moves a cell
 * boundary, these assertions fail instead of the preview silently scrolling to
 * the wrong place.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { findNotebooks, loadHarness, notebooksDir, readNotebook, samplesDir } from './harness.mjs';

const { parseMarkdown, computeCellSpans, CODE } = await loadHarness();

function toSpanInput(cell) {
    return {
        kind: cell.kind === CODE ? 'code' : 'markup',
        content: cell.content,
        rawCode: cell.rawCode,
        indentation: cell.indentation
    };
}

/** A body line matches its document line allowing for an indent the parser stripped. */
function lineMatches(documentLine, bodyLine) {
    if (documentLine === bodyLine) {
        return true;
    }
    if (bodyLine === '') {
        return documentLine.trim() === '';
    }
    return documentLine.endsWith(bodyLine)
        && documentLine.slice(0, documentLine.length - bodyLine.length).trim() === '';
}

/** Assert every invariant the preview relies on, for one notebook. */
function checkNotebook(label, text) {
    const cells = parseMarkdown(text);
    const spans = computeCellSpans(text, cells.map(toSpanInput));
    const lines = text.split(/\r?\n/g);
    const lastLine = lines.length - 1;

    assert.equal(spans.length, cells.length, `${label}: one span per cell`);

    let previousEnd = -1;
    for (let index = 0; index < cells.length; index++) {
        const { startLine, endLine } = spans[index];
        const where = `${label}: cell ${index} (${cells[index].language})`;

        assert.ok(Number.isInteger(startLine) && Number.isInteger(endLine), `${where}: integer span`);
        assert.ok(startLine >= 0 && endLine <= lastLine, `${where}: span ${startLine}-${endLine} inside 0-${lastLine}`);
        assert.ok(startLine <= endLine, `${where}: span not inverted`);
        assert.ok(startLine > previousEnd, `${where}: starts after the previous cell ended (${previousEnd})`);
        previousEnd = endLine;

        // The real check: the cell's body has to actually be sitting there.
        const isFenced = cells[index].kind === CODE || cells[index].rawCode !== undefined;
        const body = isFenced ? (cells[index].rawCode ?? cells[index].content) : cells[index].content;
        if (body === '') {
            continue;
        }
        const bodyLines = body.split('\n');
        // A fenced cell's body starts one line after its opening fence.
        const bodyStart = isFenced ? startLine + 1 : startLine;
        assert.ok(
            bodyStart + bodyLines.length - 1 <= endLine,
            `${where}: body of ${bodyLines.length} lines does not fit in ${startLine}-${endLine}`
        );
        for (let offset = 0; offset < bodyLines.length; offset++) {
            assert.ok(
                lineMatches(lines[bodyStart + offset], bodyLines[offset]),
                `${where}: line ${bodyStart + offset} is ${JSON.stringify(lines[bodyStart + offset])}, expected ${JSON.stringify(bodyLines[offset])}`
            );
        }
        if (isFenced) {
            assert.match(lines[startLine], /^\s*```/, `${where}: starts on its opening fence`);
        }
    }

    // Spans have to cover the document, so scroll sync can map any line.
    if (cells.length > 0) {
        assert.equal(spans[spans.length - 1].endLine, lastLine, `${label}: last cell runs to the end of the file`);
    }
    return cells.length;
}

// This repo is developed inside the Practical JavaScript course, which is the
// largest body of real notebooks there is; when it is checked out on its own
// there is nothing to check and the samples below carry the suite.
test('spans hold for every course notebook', async (t) => {
    const files = await findNotebooks(notebooksDir);
    if (files.length === 0) {
        t.skip(`no course notebooks at ${notebooksDir} (set WEBNB_NOTEBOOKS to point at some)`);
        return;
    }

    let cells = 0;
    for (const file of files) {
        cells += checkNotebook(path.relative(notebooksDir, file), await readNotebook(file));
    }
    console.log(`  checked ${cells} cells across ${files.length} course notebooks`);
});

test('spans hold for the extension sample notebooks', async () => {
    const files = await findNotebooks(samplesDir);
    for (const file of files) {
        checkNotebook(path.relative(samplesDir, file), await readNotebook(file));
    }
    console.log(`  checked ${files.length} sample notebooks`);
});

test('an addon block belongs to the cell it decorates', () => {
    const text = [
        'Intro paragraph.',        // 0
        '',                        // 1
        '```{javascript}',         // 2
        'const x = 1;',            // 3
        '```',                     // 4
        '',                        // 5
        '```+solution',            // 6
        'const x = 5;',            // 7
        '```',                     // 8
        '',                        // 9
        'Closing paragraph.'       // 10
    ].join('\n');

    const cells = parseMarkdown(text);
    const spans = computeCellSpans(text, cells.map(toSpanInput));

    assert.equal(cells.length, 3);
    assert.deepEqual(spans[0], { startLine: 0, endLine: 1 });
    // The code cell owns its fences AND the +solution block that follows it.
    assert.deepEqual(spans[1], { startLine: 2, endLine: 9 });
    assert.deepEqual(spans[2], { startLine: 10, endLine: 10 });
});

test('an indented cell is found at its real indentation', () => {
    const text = [
        '2. Do the thing.',                    // 0
        '',                                    // 1
        '   ```{html}',                        // 2
        '   <p>hi</p>',                        // 3
        '   ```',                              // 4
        ''                                     // 5
    ].join('\n');

    const cells = parseMarkdown(text);
    const spans = computeCellSpans(text, cells.map(toSpanInput));

    assert.equal(cells.length, 2);
    assert.equal(cells[1].indentation, '   ');
    assert.deepEqual(spans[1], { startLine: 2, endLine: 5 });
});

test('repeated identical cells are placed in order, not on top of each other', () => {
    const text = [
        '```{javascript}',   // 0
        'console.log(1);',   // 1
        '```',               // 2
        '',                  // 3
        'Middle.',           // 4
        '',                  // 5
        '```{javascript}',   // 6
        'console.log(1);',   // 7
        '```'                // 8
    ].join('\n');

    const cells = parseMarkdown(text);
    const spans = computeCellSpans(text, cells.map(toSpanInput));

    assert.equal(cells.length, 3);
    assert.deepEqual(spans[0], { startLine: 0, endLine: 3 });
    assert.deepEqual(spans[2], { startLine: 6, endLine: 8 });
});
