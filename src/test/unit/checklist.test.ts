import './tddBridge';
import * as assert from 'assert';
import {
    normalizeChecklistCheckKind,
    splitChecklistFields,
    stripChecklistLinePrefix,
    type FileChecklistCheckKind
} from '../../shared/checklist';

suite('shared/checklist', () => {
    suite('normalizeChecklistCheckKind', () => {
        const cases: [input: string, expected: FileChecklistCheckKind | undefined][] = [
            // Every alias listed in the implementation.
            ['directory', 'directory'],
            ['dir', 'directory'],
            ['file', 'file'],
            ['path', 'path'],
            ['exists', 'path'],
            ['contains', 'contains'],
            ['include', 'contains'],
            ['includes', 'contains'],
            ['notcontains', 'notContains'],
            ['notinclude', 'notContains'],
            ['notincludes', 'notContains'],
            ['doesnotcontain', 'notContains'],
            ['matches', 'matches'],
            ['match', 'matches'],
            ['regex', 'matches'],
            ['equals', 'equals'],
            ['equal', 'equals'],
            ['hasentry', 'hasEntry'],
            ['entry', 'hasEntry'],
            ['containsentry', 'hasEntry'],
            ['command', 'command'],
            ['cmd', 'command'],
            ['ran', 'command'],
            // Case, space, underscore, and hyphen insensitivity.
            ['DIR', 'directory'],
            ['File', 'file'],
            ['EXISTS', 'path'],
            ['Not Contains', 'notContains'],
            ['not_contains', 'notContains'],
            ['not-contains', 'notContains'],
            ['Does Not Contain', 'notContains'],
            ['does-not_contain', 'notContains'],
            ['Has Entry', 'hasEntry'],
            ['has_entry', 'hasEntry'],
            ['has-entry', 'hasEntry'],
            ['  dir  ', 'directory'],
            ['CMD', 'command'],
            // Separators are stripped anywhere in the string, so even interior
            // spaces inside a word vanish before matching.
            ['d i r', 'directory'],
            // Unknown kinds.
            ['folder', undefined],
            ['files', undefined],
            ['commandx', undefined],
            ['', undefined]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(normalizeChecklistCheckKind(input), expected);
            });
        }
    });

    suite('splitChecklistFields', () => {
        const cases: [input: string, expected: string[]][] = [
            // Plain pipes.
            ['a | b | c', ['a', 'b', 'c']],
            ['file.txt', ['file.txt']],
            ['a ||b', ['a', '', 'b']],
            ['a |', ['a', '']],
            // Escaped `\|` produces a literal pipe inside one field.
            ['a \\| b', ['a | b']],
            // Escaped `\\` produces a literal backslash; the following `|`
            // still splits.
            ['a \\\\| b', ['a \\', 'b']],
            // A lone trailing backslash is kept as-is.
            ['a\\', ['a\\']],
            // A backslash before any other character is kept literally.
            ['a\\b', ['a\\b']],
            // Fields are trimmed.
            ['  a  |  b  ', ['a', 'b']],
            // The empty string still yields one (empty) field.
            ['', ['']]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.deepStrictEqual(splitChecklistFields(input), expected);
            });
        }
    });

    suite('stripChecklistLinePrefix', () => {
        const cases: [input: string, expected: string][] = [
            // List markers.
            ['- item', 'item'],
            ['* item', 'item'],
            ['  - item  ', 'item'],
            // Checkboxes.
            ['[ ] item', 'item'],
            ['[x] item', 'item'],
            ['[X] item', 'item'],
            // List marker + checkbox combined.
            ['- [x] file: a.txt', 'file: a.txt'],
            ['* [ ] path: b', 'path: b'],
            // Plain lines pass through (trimmed).
            ['plain', 'plain'],
            ['  plain  ', 'plain'],
            // A marker without trailing whitespace is not a marker.
            ['-item', '-item'],
            // A checkbox must be followed by whitespace to be stripped.
            ['- [x]item', '[x]item'],
            // Not a checkbox.
            ['[y] item', '[y] item'],
            ['', '']
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(stripChecklistLinePrefix(input), expected);
            });
        }
    });
});
