import './tddBridge';
import * as assert from 'assert';
import type { Addon } from '../../shared/protocol';
import {
    getAddonContent,
    getDefaultCaptureAddons,
    isAutoWidgetLanguage,
    isCssAddon,
    isExternalCheckLanguage,
    isHtmlAddon,
    isScriptAddonType,
    isSolutionAddon,
    isTerminalAddon,
    isWalkthroughLanguage,
    normalizeAddonType,
    runsOnOpen,
    upsertAddon
} from '../../shared/addons';

suite('shared/addons', () => {
    suite('normalizeAddonType', () => {
        const cases: [input: string | undefined, expected: string][] = [
            ['test', 'test'],
            ['+test', 'test'],
            ['Test', 'test'],
            ['  +HTML ', 'html'],
            [undefined, ''],
            ['', ''],
            ['   ', ''],
            // Only one leading plus is stripped.
            ['++test', '+test']
        ];

        for (const [input, expected] of cases) {
            test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(normalizeAddonType(input), expected);
            });
        }
    });

    suite('addon-type predicates', () => {
        test('isScriptAddonType accepts test/javascript/js in any authored form', () => {
            for (const type of ['test', '+test', 'Test', 'js', 'JS', '+js', 'javascript', '+JavaScript']) {
                assert.strictEqual(isScriptAddonType(type), true, type);
            }
            for (const type of ['solution', 'typescript', '', undefined]) {
                assert.strictEqual(isScriptAddonType(type), false, String(type));
            }
        });

        test('isSolutionAddon', () => {
            for (const type of ['solution', '+solution', 'Solution']) {
                assert.strictEqual(isSolutionAddon(type), true, type);
            }
            for (const type of ['test', 'solutions', undefined]) {
                assert.strictEqual(isSolutionAddon(type), false, String(type));
            }
        });

        test('isHtmlAddon', () => {
            for (const type of ['html', '+html', 'HTML']) {
                assert.strictEqual(isHtmlAddon(type), true, type);
            }
            for (const type of ['css', undefined]) {
                assert.strictEqual(isHtmlAddon(type), false, String(type));
            }
        });

        test('isCssAddon', () => {
            for (const type of ['css', '+css', 'CSS']) {
                assert.strictEqual(isCssAddon(type), true, type);
            }
            for (const type of ['html', undefined]) {
                assert.strictEqual(isCssAddon(type), false, String(type));
            }
        });

        test('isTerminalAddon accepts terminal and xterm', () => {
            for (const type of ['terminal', '+terminal', 'Terminal', 'xterm', 'XTerm', '+xterm']) {
                assert.strictEqual(isTerminalAddon(type), true, type);
            }
            for (const type of ['term', 'shell', undefined]) {
                assert.strictEqual(isTerminalAddon(type), false, String(type));
            }
        });
    });

    suite('language predicates', () => {
        test('isExternalCheckLanguage is case-insensitive', () => {
            for (const languageId of ['external', 'checklist', 'External', 'CHECKLIST']) {
                assert.strictEqual(isExternalCheckLanguage(languageId), true, languageId);
            }
            for (const languageId of ['walkthrough', 'mcq', '']) {
                assert.strictEqual(isExternalCheckLanguage(languageId), false, languageId);
            }
        });

        test('isWalkthroughLanguage is case-insensitive', () => {
            for (const languageId of ['walkthrough', 'Walkthrough', 'WALKTHROUGH']) {
                assert.strictEqual(isWalkthroughLanguage(languageId), true, languageId);
            }
            assert.strictEqual(isWalkthroughLanguage('external'), false);
        });

        test('isAutoWidgetLanguage: mcq is case-SENSITIVE, the rest are not', () => {
            assert.strictEqual(isAutoWidgetLanguage('mcq'), true);
            assert.strictEqual(isAutoWidgetLanguage('MCQ'), false);
            assert.strictEqual(isAutoWidgetLanguage('external'), true);
            assert.strictEqual(isAutoWidgetLanguage('CHECKLIST'), true);
            assert.strictEqual(isAutoWidgetLanguage('Walkthrough'), true);
            assert.strictEqual(isAutoWidgetLanguage('javascript'), false);
        });
    });

    suite('getAddonContent', () => {
        const addons: Addon[] = [
            { type: '+test', content: 'first test' },
            { type: 'Test', content: 'second test' },
            { type: 'css', content: '' }
        ];

        test('matches on the normalized type', () => {
            assert.strictEqual(getAddonContent(addons, 'test'), 'first test');
            assert.strictEqual(getAddonContent(addons, '+TEST'), 'first test');
            assert.strictEqual(getAddonContent(addons, 'Test'), 'first test');
        });

        test('returns the first match when multiple addons normalize alike', () => {
            assert.strictEqual(getAddonContent(addons, 'test'), 'first test');
        });

        test('returns an empty string content as-is', () => {
            assert.strictEqual(getAddonContent(addons, 'CSS'), '');
        });

        test('returns undefined when no addon matches', () => {
            assert.strictEqual(getAddonContent(addons, 'solution'), undefined);
        });
    });

    suite('upsertAddon', () => {
        test('replaces an existing addon, preserving other fields but taking the new type spelling', () => {
            const input: Addon[] = [
                { type: '+test', content: 'old', id: 'a' },
                { type: 'css', content: 'body {}' }
            ];

            const result = upsertAddon(input, 'Test', 'new');

            assert.deepStrictEqual(result, [
                { type: 'Test', content: 'new', id: 'a' },
                { type: 'css', content: 'body {}' }
            ]);
        });

        test('appends when no addon of that type exists', () => {
            const input: Addon[] = [{ type: 'css', content: 'c' }];
            const result = upsertAddon(input, 'test', 'x');

            assert.deepStrictEqual(result, [
                { type: 'css', content: 'c' },
                { type: 'test', content: 'x' }
            ]);
        });

        test('does not mutate the input array or its entries', () => {
            const original: Addon[] = [{ type: '+test', content: 'old', id: 'a' }];
            const snapshot = JSON.parse(JSON.stringify(original));

            const replaced = upsertAddon(original, 'test', 'new');
            const appended = upsertAddon(original, 'css', 'body {}');

            assert.notStrictEqual(replaced, original);
            assert.notStrictEqual(appended, original);
            assert.deepStrictEqual(original, snapshot);
        });
    });

    suite('getDefaultCaptureAddons', () => {
        test('returns the same array unchanged when there is no default addon', () => {
            const input: Addon[] = [{ type: 'test', content: 'x' }];
            const result = getDefaultCaptureAddons(input, 'source');

            assert.strictEqual(result.changed, false);
            assert.strictEqual(result.addons, input);
        });

        test('leaves a non-empty default addon alone', () => {
            const input: Addon[] = [{ type: 'default', content: 'already captured' }];
            const result = getDefaultCaptureAddons(input, 'source');

            assert.strictEqual(result.changed, false);
            assert.strictEqual(result.addons, input);
            assert.strictEqual(input[0].content, 'already captured');
        });

        test('fills an empty default addon with the source', () => {
            const input: Addon[] = [
                { type: 'css', content: 'body {}' },
                { type: '+Default', content: '', id: 'd' }
            ];
            const result = getDefaultCaptureAddons(input, 'the source');

            assert.strictEqual(result.changed, true);
            assert.deepStrictEqual(result.addons, [
                { type: 'css', content: 'body {}' },
                { type: '+Default', content: 'the source', id: 'd' }
            ]);
            // Input is not mutated.
            assert.strictEqual(input[1].content, '');
        });

        test('whitespace-only content counts as empty', () => {
            const input: Addon[] = [{ type: 'default', content: '  \n\t ' }];
            const result = getDefaultCaptureAddons(input, 'src');

            assert.strictEqual(result.changed, true);
            assert.strictEqual(result.addons[0].content, 'src');
        });
    });

    suite('runsOnOpen', () => {
        test('a plain cell waits to be run', () => {
            assert.strictEqual(runsOnOpen({ languageId: 'javascript' }), false);
            assert.strictEqual(runsOnOpen({ languageId: 'html' }), false);
        });

        test('autorun and the widget languages run on open', () => {
            assert.strictEqual(runsOnOpen({ languageId: 'javascript', autorun: true }), true);
            for (const languageId of ['mcq', 'external', 'checklist', 'walkthrough']) {
                assert.strictEqual(runsOnOpen({ languageId }), true, languageId);
            }
        });

        test('hidecode runs on open by itself', () => {
            // The reason the flag implies it: a hidden cell offers the reader a
            // Run button for code they cannot see, which is not a real choice.
            assert.strictEqual(runsOnOpen({ languageId: 'javascript', hidecode: true }), true);
            assert.strictEqual(runsOnOpen({ languageId: 'html', hidecode: true }), true);
        });

        test('runonstart is spent once, the others are not', () => {
            const runonstart = { languageId: 'javascript', runonstart: true };
            assert.strictEqual(runsOnOpen(runonstart), true);
            assert.strictEqual(runsOnOpen(runonstart, { runOnStartAlreadyDone: true }), false);

            // A cell that also carries hidecode keeps running after that.
            const both = { languageId: 'javascript', runonstart: true, hidecode: true };
            assert.strictEqual(runsOnOpen(both, { runOnStartAlreadyDone: true }), true);
        });
    });
});
