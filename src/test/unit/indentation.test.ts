import './tddBridge';
import * as assert from 'assert';
import {
    applyIndentation,
    commonIndentation,
    dedent,
    stripIndentation
} from '../../shared/indentation';

suite('shared/indentation', () => {
    suite('commonIndentation', () => {
        test('is the whitespace every non-blank line agrees on', () => {
            assert.strictEqual(commonIndentation(['    a', '    b']), '    ');
            assert.strictEqual(commonIndentation(['    a', '        b']), '    ');
            assert.strictEqual(commonIndentation(['    a', '  b']), '  ');
            assert.strictEqual(commonIndentation(['a', '    b']), '');
        });

        test('blank lines are ignored, not counted as unindented', () => {
            assert.strictEqual(commonIndentation(['    a', '', '    b']), '    ');
            assert.strictEqual(commonIndentation(['    a', '   ', '    b']), '    ');
        });

        test('tabs and spaces only agree where they are identical', () => {
            assert.strictEqual(commonIndentation(['\ta', '\tb']), '\t');
            assert.strictEqual(commonIndentation(['\ta', '    b']), '');
        });

        test('no lines, or only blank ones, is no indentation', () => {
            assert.strictEqual(commonIndentation([]), '');
            assert.strictEqual(commonIndentation(['', '   ']), '');
        });
    });

    suite('dedent', () => {
        test('removes the shared indent and keeps the rest', () => {
            // The point of the whole module: 4 spaces of list indentation go,
            // the 4 further spaces that make a snippet a code block stay.
            assert.strictEqual(
                dedent('    Question text\n\n        <p>snippet</p>'),
                'Question text\n\n    <p>snippet</p>'
            );
        });

        test('leaves unindented text alone', () => {
            assert.strictEqual(dedent('a\n  b'), 'a\n  b');
        });

        test('a short whitespace-only line is emptied; a long one keeps its remainder', () => {
            // Under-indented blank lines cannot be content, so they go. Lines
            // that do carry the indent are body text -- inside a fence that is
            // code -- so what is left of them is preserved verbatim.
            assert.strictEqual(dedent('    a\n  \n    b'), 'a\n\nb');
            assert.strictEqual(dedent('    a\n      \n    b'), 'a\n  \nb');
        });
    });

    suite('stripIndentation', () => {
        test('removes the prefix when the line has it', () => {
            assert.strictEqual(stripIndentation('    a', '    '), 'a');
        });

        test('a line that does not have the prefix is kept as-is', () => {
            assert.strictEqual(stripIndentation('  a', '    '), '  a');
        });

        test('a whitespace-only line is emptied whatever it held', () => {
            assert.strictEqual(stripIndentation('  ', '    '), '');
            assert.strictEqual(stripIndentation('\t', '    '), '');
        });
    });

    suite('applyIndentation', () => {
        test('is the inverse of dedent for indented text', () => {
            const source = '    a\n\n        b';
            assert.strictEqual(applyIndentation(dedent(source), '    '), source);
        });

        test('blank lines stay blank rather than gaining trailing spaces', () => {
            assert.strictEqual(applyIndentation('a\n\nb', '  '), '  a\n\n  b');
        });
    });
});
