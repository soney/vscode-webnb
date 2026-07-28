import './tddBridge';
import * as assert from 'assert';
import {
    formatChecklistInterval,
    parseChecklistInterval,
    parseFileChecklistSource,
    parseRegexLike
} from '../../client/checks';

suite('client/checks (parsing helpers)', () => {
    suite('parseFileChecklistSource', () => {
        test('a bare first line becomes the title', () => {
            const parsed = parseFileChecklistSource('My Checklist\nfile: a.txt');
            assert.strictEqual(parsed.title, 'My Checklist');
            assert.strictEqual(parsed.checks.length, 1);
            assert.deepStrictEqual(parsed.errors, []);
        });

        test('`title:` sets the title explicitly', () => {
            const parsed = parseFileChecklistSource('title: Custom Title\nfile: a.txt');
            assert.strictEqual(parsed.title, 'Custom Title');
        });

        test('defaults: no title, 2000ms interval', () => {
            const parsed = parseFileChecklistSource('file: a.txt');
            assert.strictEqual(parsed.title, undefined);
            assert.strictEqual(parsed.intervalMs, 2000);
        });

        test('a second bare line is an error, not a title', () => {
            const parsed = parseFileChecklistSource('Title\nJust text\nfile: a.txt');
            assert.strictEqual(parsed.title, 'Title');
            assert.deepStrictEqual(parsed.errors, ['Line 2 is not a valid checklist item: `Just text`']);
        });

        test('a bare line after a check is an error', () => {
            const parsed = parseFileChecklistSource('file: a.txt\nAnother title?');
            assert.deepStrictEqual(parsed.errors, ['Line 2 is not a valid checklist item: `Another title?`']);
        });

        test('valid `interval:` values (and key aliases) set intervalMs', () => {
            assert.strictEqual(parseFileChecklistSource('interval: 5s\nfile: a').intervalMs, 5000);
            assert.strictEqual(parseFileChecklistSource('refresh: off\nfile: a').intervalMs, 0);
            assert.strictEqual(parseFileChecklistSource('check-every: 1m\nfile: a').intervalMs, 60000);
            assert.strictEqual(parseFileChecklistSource('poll: 250ms\nfile: a').intervalMs, 250);
        });

        test('an invalid interval is an error and keeps the default', () => {
            const parsed = parseFileChecklistSource('interval: soon\nfile: a.txt');
            assert.strictEqual(parsed.intervalMs, 2000);
            assert.deepStrictEqual(parsed.errors, ['Line 1 has an invalid interval: `soon`']);
        });

        test('an unknown kind is an error', () => {
            const parsed = parseFileChecklistSource('frobnicate: x');
            assert.deepStrictEqual(parsed.errors, ['Line 1 has an unknown check type: `frobnicate`']);
            assert.deepStrictEqual(parsed.checks, []);
        });

        test('a known kind with no path is an error', () => {
            const parsed = parseFileChecklistSource('file:');
            assert.deepStrictEqual(parsed.errors, ['Line 1 is missing a path.']);
        });

        test('value kinds without a value are errors', () => {
            for (const line of ['contains: a.txt', 'notcontains: a.txt', 'matches: a.txt', 'equals: a.txt', 'entry: a.txt']) {
                const parsed = parseFileChecklistSource(line);
                assert.deepStrictEqual(parsed.errors, ['Line 1 is missing the value to check.'], line);
                assert.deepStrictEqual(parsed.checks, [], line);
            }
        });

        test('path kinds read the label from fields[1]', () => {
            const parsed = parseFileChecklistSource('file: a.txt | Make the file');
            assert.deepStrictEqual(parsed.checks, [{
                kind: 'file',
                path: 'a.txt',
                value: 'Make the file',
                label: 'Make the file',
                rawLine: 'file: a.txt | Make the file'
            }]);
        });

        test('value kinds read the label from fields[2]', () => {
            const parsed = parseFileChecklistSource('contains: a.txt | needle | Find it');
            assert.deepStrictEqual(parsed.checks, [{
                kind: 'contains',
                path: 'a.txt',
                value: 'needle',
                label: 'Find it',
                rawLine: 'contains: a.txt | needle | Find it'
            }]);
        });

        test('value kinds without a third field have no label', () => {
            const parsed = parseFileChecklistSource('contains: a.txt | needle');
            assert.deepStrictEqual(parsed.checks, [{
                kind: 'contains',
                path: 'a.txt',
                value: 'needle',
                label: undefined,
                rawLine: 'contains: a.txt | needle'
            }]);
        });

        test('`command:` kind stores the command as the path with fields[1] as label', () => {
            const parsed = parseFileChecklistSource('command: npm test | Run the tests');
            assert.deepStrictEqual(parsed.checks, [{
                kind: 'command',
                path: 'npm test',
                value: 'Run the tests',
                label: 'Run the tests',
                rawLine: 'command: npm test | Run the tests'
            }]);
        });

        test('kind keys tolerate spaces/underscores/hyphens and case', () => {
            const parsed = parseFileChecklistSource('Has Entry: package.json | main | Add main');
            assert.strictEqual(parsed.checks[0].kind, 'hasEntry');
            assert.strictEqual(parsed.checks[0].value, 'main');
            assert.strictEqual(parsed.checks[0].label, 'Add main');
        });

        test('list markers and checkboxes are stripped; rawLine keeps the trimmed original', () => {
            const parsed = parseFileChecklistSource('  - [ ] file: a.txt | Label  ');
            assert.deepStrictEqual(parsed.checks, [{
                kind: 'file',
                path: 'a.txt',
                value: 'Label',
                label: 'Label',
                rawLine: '- [ ] file: a.txt | Label'
            }]);
        });

        test('comments and blank lines are skipped', () => {
            const parsed = parseFileChecklistSource('# note\n\nfile: a.txt');
            assert.strictEqual(parsed.checks.length, 1);
            assert.deepStrictEqual(parsed.errors, []);
        });

        test('escaped pipes stay inside a field', () => {
            const parsed = parseFileChecklistSource('contains: a.txt | a \\| b');
            assert.strictEqual(parsed.checks[0].value, 'a | b');
        });
    });

    suite('parseChecklistInterval', () => {
        const cases: [input: string, expected: number | undefined][] = [
            // A bare number is milliseconds.
            ['500', 500],
            ['0', 0],
            // Seconds family.
            ['2s', 2000],
            ['2 sec', 2000],
            ['3secs', 3000],
            ['1second', 1000],
            ['4 seconds', 4000],
            ['1.5s', 1500],
            // Minutes family.
            ['2m', 120000],
            ['1min', 60000],
            ['2 mins', 120000],
            ['1minute', 60000],
            ['2 minutes', 120000],
            // Explicit milliseconds.
            ['250ms', 250],
            // Off words.
            ['off', 0],
            ['false', 0],
            ['none', 0],
            ['manual', 0],
            ['OFF', 0],
            ['Manual', 0],
            // Invalid.
            ['abc', undefined],
            ['', undefined],
            ['-5', undefined],
            ['5h', undefined],
            ['s', undefined]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(parseChecklistInterval(input), expected);
            });
        }
    });

    suite('formatChecklistInterval', () => {
        const cases: [ms: number, expected: string][] = [
            [60000, '1 minute'],
            [120000, '2 minutes'],
            // Not a whole number of minutes falls to seconds.
            [90000, '90 seconds'],
            [61000, '61 seconds'],
            [1000, '1 second'],
            [2000, '2 seconds'],
            // Not a whole number of seconds falls to raw ms.
            [1500, '1500 ms'],
            [60500, '60500 ms'],
            [999, '999 ms'],
            [0, '0 ms']
        ];

        for (const [ms, expected] of cases) {
            test(`${ms} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(formatChecklistInterval(ms), expected);
            });
        }
    });

    suite('parseRegexLike', () => {
        test('`/re/i` becomes a RegExp with the s flag forced on', () => {
            const result = parseRegexLike('/re/i');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.source, 're');
            assert.strictEqual(result.flags, 'is');
        });

        test('an existing s flag is not duplicated', () => {
            const result = parseRegexLike('/a.b/s');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.flags, 's');
        });

        test('no flags still gains s', () => {
            const result = parseRegexLike('/x/');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.flags, 's');
        });

        test('multiple flags keep their order with s appended', () => {
            const result = parseRegexLike('/x/gim');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.flags, 'gims');
        });

        test('the forced s flag makes `.` match newlines', () => {
            const result = parseRegexLike('/a.b/');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.test('a\nb'), true);
        });

        test('escaped slashes are allowed inside the pattern', () => {
            const result = parseRegexLike('/a\\/b/');
            assert.ok(result instanceof RegExp);
            assert.strictEqual(result.test('a/b'), true);
        });

        const nonRegex = ['plain', '/unclosed', '//', 'a/b/', ''];
        for (const value of nonRegex) {
            test(`${JSON.stringify(value)} stays a string`, () => {
                assert.strictEqual(parseRegexLike(value), value);
            });
        }
    });
});
