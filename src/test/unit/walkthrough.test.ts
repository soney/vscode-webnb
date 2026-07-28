import './tddBridge';
import * as assert from 'assert';
import {
    parseWalkthroughSource,
    parseWalkthroughWatchValue,
    toWalkthroughSnapshotKey
} from '../../client/walkthrough';

suite('client/walkthrough', () => {
    suite('parseWalkthroughWatchValue', () => {
        const cases: [input: string, expected: number][] = [
            // Off words and empty.
            ['', 0],
            ['off', 0],
            ['false', 0],
            ['no', 0],
            ['none', 0],
            ['0', 0],
            // On words use the default interval (2000ms).
            ['on', 2000],
            ['true', 2000],
            ['yes', 2000],
            ['ON', 2000],
            // A bare number is SECONDS.
            ['5', 5000],
            ['1.5', 1500],
            // Explicit units.
            ['2s', 2000],
            ['750ms', 750],
            ['1m', 60000],
            // Values below the 500ms minimum are clamped up.
            ['250ms', 500],
            ['0.1s', 500],
            // `0s` is not an off word, so it hits the clamp instead of 0.
            ['0s', 500],
            // Unparseable values turn watching off.
            ['garbage', 0],
            ['5h', 0]
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${expected}`, () => {
                assert.strictEqual(parseWalkthroughWatchValue(input), expected);
            });
        }
    });

    suite('toWalkthroughSnapshotKey', () => {
        const cases: [input: string, expected: string][] = [
            ['src/a.ts', 'src/a.ts'],
            ['  a.txt ', 'a.txt'],
            // Backslashes normalize to forward slashes.
            ['src\\a.ts', 'src/a.ts'],
            // `workspace:` prefix is canonicalized (case, spacing).
            ['workspace: src/a.ts', 'workspace:src/a.ts'],
            ['WORKSPACE : x\\y', 'workspace:x/y'],
            ['workspace:', 'workspace:']
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(toWalkthroughSnapshotKey(input), expected);
            });
        }
    });

    suite('parseWalkthroughSource', () => {
        test('parses title, intro, and a fully specified step', () => {
            const source = [
                'title: Tour',
                'Intro line one.',
                '',
                'file: src/app.ts',
                'Step commentary.',
                'lines: 3-5, 8',
                'highlight: 4',
                'language: ts',
                'watch: on'
            ].join('\n');

            const parsed = parseWalkthroughSource(source);
            assert.strictEqual(parsed.title, 'Tour');
            assert.strictEqual(parsed.intro, 'Intro line one.');
            assert.strictEqual(parsed.watchIntervalMs, 2000);
            assert.deepStrictEqual(parsed.errors, []);
            assert.strictEqual(parsed.steps.length, 1);

            const step = parsed.steps[0];
            assert.strictEqual(step.file, 'src/app.ts');
            assert.deepStrictEqual(step.lines, [{ start: 3, end: 5 }, { start: 8, end: 8 }]);
            assert.deepStrictEqual(step.highlights, [{ start: 4, end: 4 }]);
            assert.strictEqual(step.language, 'ts');
            assert.strictEqual(step.commentary, 'Step commentary.');
        });

        test('a second `file:` line starts a new step', () => {
            const parsed = parseWalkthroughSource([
                'file: a.ts',
                'first commentary',
                'file: b.ts',
                'second commentary'
            ].join('\n'));

            assert.strictEqual(parsed.steps.length, 2);
            assert.strictEqual(parsed.steps[0].file, 'a.ts');
            assert.strictEqual(parsed.steps[0].commentary, 'first commentary');
            assert.strictEqual(parsed.steps[1].file, 'b.ts');
            assert.strictEqual(parsed.steps[1].commentary, 'second commentary');
        });

        test('`step:` starts a titled step; `title:` inside a step renames it', () => {
            const parsed = parseWalkthroughSource([
                'step: Setup',
                'file: a.ts',
                'title: Renamed'
            ].join('\n'));

            assert.strictEqual(parsed.steps.length, 1);
            assert.strictEqual(parsed.steps[0].title, 'Renamed');
            assert.strictEqual(parsed.title, undefined);
        });

        test('reversed line ranges are normalized (5-2 becomes 2..5)', () => {
            const parsed = parseWalkthroughSource('file: a.ts\nlines: 5-2');
            assert.deepStrictEqual(parsed.steps[0].lines, [{ start: 2, end: 5 }]);
        });

        test('`watch:` values are wired through parseWalkthroughWatchValue', () => {
            assert.strictEqual(parseWalkthroughSource('watch: 5\nfile: a.ts').watchIntervalMs, 5000);
            assert.strictEqual(parseWalkthroughSource('watch: off\nfile: a.ts').watchIntervalMs, 0);
        });

        test('`file:` without a path is an error and creates no step', () => {
            const parsed = parseWalkthroughSource('file:');
            assert.deepStrictEqual(parsed.errors, ['A `file:` line needs a path.']);
            assert.deepStrictEqual(parsed.steps, []);
        });

        test('`region:` attaches to the current step', () => {
            const parsed = parseWalkthroughSource('file: a.ts\nregion: setup');
            assert.strictEqual(parsed.steps[0].region, 'setup');
        });

        test('key lines must start at column 0; indented ones are commentary', () => {
            const parsed = parseWalkthroughSource('file: a.ts\n  file: b.ts');
            assert.strictEqual(parsed.steps.length, 1);
            assert.strictEqual(parsed.steps[0].commentary, 'file: b.ts');
        });
    });
});
