import './tddBridge';
import * as assert from 'assert';
import {
    getMcqDisplayOptions,
    parseMcqSelectionAddonContent,
    parseMcqSource,
    serializeMcqSelectionAddonContent,
    type McqOption
} from '../../client/mcq';

suite('client/mcq', () => {
    suite('parseMcqSource', () => {
        test('parses question, options, per-option feedback, and top-level feedback', () => {
            const source = [
                'What is 2+2?',
                'More question text.',
                'shuffle: false',
                'correct: Well done',
                'wrong: Try again',
                '[x] 4',
                '  correct: yes indeed',
                '  wrong: pick 4',
                '[ ] 5',
                '- [X] four'
            ].join('\n');

            assert.deepStrictEqual(parseMcqSource(source), {
                question: 'What is 2+2?\nMore question text.',
                options: [
                    { text: '4', correct: true, correctFeedback: 'yes indeed', wrongFeedback: 'pick 4' },
                    { text: '5', correct: false },
                    { text: 'four', correct: true }
                ],
                correctFeedback: 'Well done',
                wrongFeedback: 'Try again',
                shuffle: false,
                deterministic: false
            });
        });

        test('defaults: shuffle on, not deterministic, no feedback', () => {
            const parsed = parseMcqSource('Q\n[x] a');
            assert.strictEqual(parsed.shuffle, true);
            assert.strictEqual(parsed.deterministic, false);
            assert.strictEqual(parsed.correctFeedback, undefined);
            assert.strictEqual(parsed.wrongFeedback, undefined);
        });

        test('option markers: `[x]`/`[X]` mark correct, `[ ]` incorrect, text is trimmed', () => {
            const parsed = parseMcqSource('Q\n[x]   spaced   \n[ ] plain\n- [X] listed');
            assert.deepStrictEqual(parsed.options, [
                { text: 'spaced', correct: true },
                { text: 'plain', correct: false },
                { text: 'listed', correct: true }
            ]);
        });

        test('`incorrect:` is an alias for per-option wrong feedback', () => {
            const parsed = parseMcqSource('Q\n[ ] b\n\tincorrect: nope');
            assert.strictEqual(parsed.options[0].wrongFeedback, 'nope');
        });

        suite('shuffle flag values', () => {
            const cases: [value: string, shuffle: boolean, deterministic: boolean][] = [
                ['true', true, false],
                ['yes', true, false],
                ['on', true, false],
                ['1', true, false],
                ['false', false, false],
                ['no', false, false],
                ['off', false, false],
                ['0', false, false],
                ['deterministic', true, true],
                ['stable', true, true],
                ['random', true, false],
                // Unrecognized and empty values fall back to the default (true).
                ['garbage', true, false],
                ['', true, false]
            ];

            for (const [value, shuffle, deterministic] of cases) {
                test(`shuffle: ${JSON.stringify(value)} -> shuffle=${shuffle}, deterministic=${deterministic}`, () => {
                    const parsed = parseMcqSource(`Q\nshuffle: ${value}\n[x] a`);
                    assert.strictEqual(parsed.shuffle, shuffle);
                    assert.strictEqual(parsed.deterministic, deterministic);
                });
            }
        });

        test('`deterministic:` flag is independent of shuffle', () => {
            const parsed = parseMcqSource('Q\ndeterministic: yes\n[x] a');
            assert.strictEqual(parsed.shuffle, true);
            assert.strictEqual(parsed.deterministic, true);
        });

        test('flag lines after the first option are treated as question text', () => {
            const parsed = parseMcqSource('What?\ncorrect: pre\n[x] a\ncorrect: post\ntail line');
            assert.strictEqual(parsed.correctFeedback, 'pre');
            assert.strictEqual(parsed.question, 'What?\ncorrect: post\ntail line');
        });
    });

    suite('getMcqDisplayOptions', () => {
        const options: McqOption[] = [
            { text: 'a', correct: false },
            { text: 'b', correct: false },
            { text: 'c', correct: true },
            { text: 'd', correct: false },
            { text: 'e', correct: false }
        ];

        test('no shuffle keeps the original order with originalIndex', () => {
            const display = getMcqDisplayOptions(options, false, false, 'seed');
            assert.deepStrictEqual(
                display.map(option => ({ text: option.text, originalIndex: option.originalIndex })),
                options.map((option, index) => ({ text: option.text, originalIndex: index }))
            );
        });

        test('fewer than two options are never shuffled', () => {
            const display = getMcqDisplayOptions([{ text: 'only', correct: true }], true, false, 'seed');
            assert.deepStrictEqual(display, [{ text: 'only', correct: true, originalIndex: 0 }]);
        });

        test('deterministic shuffle is stable across calls for the same seed source', () => {
            const first = getMcqDisplayOptions(options, true, true, 'seed-1');
            const second = getMcqDisplayOptions(options, true, true, 'seed-1');
            assert.deepStrictEqual(
                first.map(option => option.originalIndex),
                second.map(option => option.originalIndex)
            );
            // Current golden order for this seed and option count.
            assert.deepStrictEqual(first.map(option => option.originalIndex), [0, 3, 1, 2, 4]);
        });

        test('shuffling preserves the option set (it is a permutation)', () => {
            for (const deterministic of [true, false]) {
                const display = getMcqDisplayOptions(options, true, deterministic, 'any-seed');
                const restored = display
                    .slice()
                    .sort((left, right) => left.originalIndex - right.originalIndex)
                    .map(({ text, correct }) => ({ text, correct }));
                assert.deepStrictEqual(restored, options, `deterministic=${deterministic}`);
            }
        });

        test('does not mutate the input options', () => {
            const snapshot = JSON.parse(JSON.stringify(options));
            getMcqDisplayOptions(options, true, true, 'seed');
            assert.deepStrictEqual(options, snapshot);
        });
    });

    suite('parseMcqSelectionAddonContent', () => {
        const cases: [content: string, optionCount: number, expected: number[]][] = [
            // JSON array.
            ['[0,2]', 3, [0, 2]],
            // `{"selected": [...]}` object form, order preserved.
            ['{"selected":[2,0]}', 3, [2, 0]],
            // Numeric strings inside JSON are coerced.
            ['{"selected":["1"]}', 3, [1]],
            // Loose whitespace/comma text.
            ['0, 2 1', 3, [0, 2, 1]],
            ['0,, 1', 3, [0, 1]],
            // Out-of-range, negative, and non-integer values are filtered.
            ['[0, 5, -1, 1.5]', 3, [0]],
            // Duplicates keep only the first occurrence.
            ['[1, 1, 0]', 3, [1, 0]],
            // Empty and whitespace-only content.
            ['', 3, []],
            ['   ', 3, []],
            // JSON that is neither an array nor {selected: [...]} yields nothing.
            ['{"a":1}', 3, []],
            ['"1"', 3, []],
            // Non-numeric tokens in loose text are dropped.
            ['a b 1', 3, [1]],
            // optionCount of zero filters everything.
            ['[0]', 0, []]
        ];

        for (const [content, optionCount, expected] of cases) {
            test(`${JSON.stringify(content)} (count ${optionCount}) -> ${JSON.stringify(expected)}`, () => {
                assert.deepStrictEqual(parseMcqSelectionAddonContent(content, optionCount), expected);
            });
        }
    });

    suite('serializeMcqSelectionAddonContent', () => {
        test('serializes to the {"selected": [...]} form', () => {
            assert.strictEqual(serializeMcqSelectionAddonContent([0, 2]), '{"selected":[0,2]}');
            assert.strictEqual(serializeMcqSelectionAddonContent([]), '{"selected":[]}');
        });

        test('round-trips through parseMcqSelectionAddonContent', () => {
            const indices = [2, 0, 1];
            assert.deepStrictEqual(
                parseMcqSelectionAddonContent(serializeMcqSelectionAddonContent(indices), 3),
                indices
            );
        });
    });
});
