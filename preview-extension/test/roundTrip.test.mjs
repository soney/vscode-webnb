/**
 * Opening a notebook and saving it must not rewrite the file.
 *
 * The serializer is the only thing standing between an author's Markdown and
 * what lands on disk, and every loss it takes is silent: nothing surfaces until
 * a diff shows blank lines gone or indentation added. So this checks
 * parse -> write against every real notebook there is, byte for byte.
 *
 * These live here rather than in src/test because markdownParser.ts imports
 * `vscode`; this folder already bundles it against a stub to run the parser
 * under node.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { findNotebooks, loadHarness, notebooksDir, readNotebook, samplesDir } from './harness.mjs';

const { parseMarkdown, writeCellsToMarkdown, toCellData } = await loadHarness();

/** Parse a document and write it straight back out, as saving does. */
function roundTrip(text) {
    return writeCellsToMarkdown(toCellData(parseMarkdown(text)));
}

/** The first line where two documents differ, for a readable failure. */
function firstDifference(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        if (a[index] !== b[index]) {
            return `line ${index}\n     on disk: ${JSON.stringify(a[index])}\n     written: ${JSON.stringify(b[index])}`;
        }
    }
    return 'no line differs (trailing newline?)';
}

/**
 * Files the serializer still rewrites once, and why. Each is a form the parser
 * cannot tell apart from the canonical one, so writing has to pick a side:
 *
 *  - an empty block written as fence/blank/fence rather than fence/fence;
 *  - `{jsx}`, an alias of `{react}`, which comes back as the canonical spelling
 *    (sample.webnb demonstrates the alias on purpose, so it stays as authored).
 *
 * Rewriting each file once empties this list. Anything NOT listed that starts
 * drifting is a regression, which is what the test below is for.
 */
const AWAITING_NORMALIZATION = new Set([
    '02 - Creating HTML Elements.webnb',
    '03 - Foundational HTML Elements.webnb',
    '04 - Nesting HTML Elements.webnb',
    '06 - Element Attributes.webnb',
    '07 - Common Attributes.webnb',
    'sample.webnb'
]);

async function checkCorpus(dir, label) {
    const files = await findNotebooks(dir);
    let unchanged = 0;
    for (const file of files) {
        const text = await readNotebook(file);
        const written = roundTrip(text);
        if (written === text) {
            unchanged++;
            continue;
        }
        assert.ok(
            AWAITING_NORMALIZATION.has(path.basename(file)),
            `${label}/${path.relative(dir, file)} is newly rewritten by a save: ${firstDifference(text, written)}`
        );
    }
    return { total: files.length, unchanged };
}

test('saving a course notebook leaves it byte-identical', async (t) => {
    const files = await findNotebooks(notebooksDir);
    if (files.length === 0) {
        t.skip(`no course notebooks at ${notebooksDir} (set WEBNB_NOTEBOOKS to point at some)`);
        return;
    }
    const { total, unchanged } = await checkCorpus(notebooksDir, 'notebooks');
    console.log(`  ${unchanged}/${total} course notebooks survive a save unchanged`);
});

test('saving a sample notebook leaves it byte-identical', async () => {
    const { total, unchanged } = await checkCorpus(samplesDir, 'samplenotebooks');
    console.log(`  ${unchanged}/${total} sample notebooks survive a save unchanged`);
});

/**
 * The guarantee that has to hold with no exceptions: whatever the serializer
 * normalizes, it normalizes once. A file that keeps changing on every save
 * would churn a diff forever.
 */
test('saving is idempotent for every notebook', async () => {
    const dirs = [[notebooksDir, 'notebooks'], [samplesDir, 'samplenotebooks']];
    let checked = 0;
    for (const [dir, label] of dirs) {
        for (const file of await findNotebooks(dir)) {
            const once = roundTrip(await readNotebook(file));
            assert.equal(
                roundTrip(once),
                once,
                `${label}/${path.relative(dir, file)} changes on every save`
            );
            checked++;
        }
    }
    console.log(`  ${checked} notebooks reach a fixed point after one save`);
});

test('the blank line between a cell and its addons survives', () => {
    const text = [
        '```{javascript}',
        'const x = 1;',
        '```',
        '',
        '```+solution',
        'const x = 5;',
        '```',
        '',
        '```+test',
        'wrap(x).should("equal", 5);',
        '```',
        ''
    ].join('\n');

    assert.equal(roundTrip(text), text);
});

test('addons written tight against their cell stay tight', () => {
    const text = [
        '```{javascript}',
        'const x = 1;',
        '```',
        '```+solution',
        'const x = 5;',
        '```',
        ''
    ].join('\n');

    assert.equal(roundTrip(text), text);
});

test('an indented cell keeps its indentation, and its blank lines stay blank', () => {
    const text = [
        '2. Do the thing.',
        '',
        '   ```{html}',
        '   <p>one</p>',
        '',
        '   <p>two</p>',
        '   ```',
        ''
    ].join('\n');

    assert.equal(roundTrip(text), text);
    // The blank line inside the fence must not come back as three spaces.
    assert.ok(!/^ +$/m.test(roundTrip(text)), 'a blank line gained trailing whitespace');
});

test('indented prose is a markup cell, not indented content', () => {
    const text = [
        '2. Write a CSS rule.',
        '',
        '    The HTML this cell works with:',
        ''
    ].join('\n');

    const cells = parseMarkdown(text);
    const prose = cells[cells.length - 1];
    // Dedented in the cell -- so Markdown reads it as a paragraph, not a code
    // block -- with the indentation kept as metadata and restored on write.
    assert.equal(prose.content, 'The HTML this cell works with:');
    assert.equal(prose.indentation, '    ');
    assert.equal(roundTrip(text), text);
});

test('hidecode is parsed, carried, and written back', () => {
    const text = [
        '```{html runonstart hidecode}',
        '<div id="widget"></div>',
        '```',
        ''
    ].join('\n');

    const cell = parseMarkdown(text)[0];
    assert.equal(cell.hidecode, true);
    assert.equal(cell.runonstart, true);
    assert.equal(roundTrip(text), text);
});

test('hidecode is read in any order, and written in the canonical one', () => {
    const authored = '```{javascript hidecode autorun id=chart}\nx\n```\n';
    const cell = parseMarkdown(authored)[0];
    assert.equal(cell.id, 'chart');
    assert.equal(cell.autorun, true);
    assert.equal(cell.hidecode, true);

    // Flags are re-emitted in a fixed order (id, autorun, runonstart, hidecode),
    // which predates this flag -- `{js runonstart id=x}` has always come back as
    // `{js id=x runonstart}`. So a save can reorder flags once. What must hold is
    // that the meaning survives and the second save changes nothing.
    const written = roundTrip(authored);
    assert.equal(written, '```{javascript id=chart autorun hidecode}\nx\n```\n');
    const reparsed = parseMarkdown(written)[0];
    assert.equal(reparsed.id, 'chart');
    assert.equal(reparsed.autorun, true);
    assert.equal(reparsed.hidecode, true);
    assert.equal(roundTrip(written), written);
});

test('a cell without the flag does not gain it', () => {
    const cell = parseMarkdown('```{javascript}\nx\n```\n')[0];
    assert.equal(cell.hidecode, undefined);
    assert.ok(!roundTrip('```{javascript}\nx\n```\n').includes('hidecode'));
});

test('height is parsed, carried, and written back', () => {
    const text = [
        '```{html height=300}',
        '<div id="widget"></div>',
        '```',
        ''
    ].join('\n');

    const cell = parseMarkdown(text)[0];
    assert.equal(cell.height, '300');
    assert.equal(roundTrip(text), text);
});

test('a height is kept exactly as authored, whatever the unit', () => {
    for (const value of ['300', '300px', '20em', '50vh', 'auto']) {
        const text = `\`\`\`{html height=${value}}\n<p>x</p>\n\`\`\`\n`;
        assert.equal(parseMarkdown(text)[0].height, value);
        assert.equal(roundTrip(text), text, `height=${value} did not survive a save`);
    }
});

test('a height that is not a length still survives a save', () => {
    // The parser does not judge the value -- dropping it would delete what the
    // author typed. It simply does not size anything at render time.
    const text = '```{html height=tall}\n<p>x</p>\n```\n';
    assert.equal(parseMarkdown(text)[0].height, 'tall');
    assert.equal(roundTrip(text), text);
});

test('height on a reference cell survives, alongside the other flags', () => {
    // A fence with attributes but no braces is a markup cell: its attributes
    // live only in metadata, so writing them back is the only thing keeping
    // them in the file.
    const authored = '```html id=layout hidecode height=240\n<p>x</p>\n```\n';
    const cell = parseMarkdown(authored)[0];
    assert.equal(cell.id, 'layout');
    assert.equal(cell.hidecode, true);
    assert.equal(cell.height, '240');

    const written = roundTrip(authored);
    assert.equal(written, authored);
    assert.equal(roundTrip(written), written);
});

test('a cell without a height does not gain one', () => {
    const cell = parseMarkdown('```{html}\n<p>x</p>\n```\n')[0];
    assert.equal(cell.height, undefined);
    assert.ok(!roundTrip('```{html}\n<p>x</p>\n```\n').includes('height'));
});

test('an empty cell body round-trips to the canonical two-line form', () => {
    const canonical = ['```{html}', '```', ''].join('\n');
    const withBlank = ['```{html}', '', '```', ''].join('\n');

    // Both parse to the same empty cell, so the serializer settles on one form.
    assert.equal(parseMarkdown(canonical)[0].content, '');
    assert.equal(parseMarkdown(withBlank)[0].content, '');
    assert.equal(roundTrip(canonical), canonical);
    assert.equal(roundTrip(withBlank), canonical);
    // Whichever form it picks, a second save must be a no-op.
    assert.equal(roundTrip(roundTrip(withBlank)), roundTrip(withBlank));
});

