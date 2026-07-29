import './tddBridge';
import * as assert from 'assert';
import { isRendererMessage } from '../../shared/protocol';

suite('shared/protocol', () => {
    suite('isRendererMessage', () => {
        suite('accepts each message shape', () => {
            const valid: [label: string, message: unknown][] = [
                ['refreshCell', { type: 'webnb.refreshCell', cellUri: 'cell:0' }],
                ['resetCellSource', { type: 'webnb.resetCellSource', cellUri: 'cell:0' }],
                ['upsertCellAddon', { type: 'webnb.upsertCellAddon', cellUri: 'cell:0', addonType: 'selection', content: '{}' }],
                ['upsertCellAddon with empty content', { type: 'webnb.upsertCellAddon', cellUri: 'cell:0', addonType: 't', content: '' }],
                ['openWorkspaceFile without line', { type: 'webnb.openWorkspaceFile', cellUri: 'cell:0', path: 'src/a.ts' }],
                ['openWorkspaceFile with line', { type: 'webnb.openWorkspaceFile', cellUri: 'cell:0', path: 'src/a.ts', line: 3 }],
                ['highlightWorkspaceLines minimal', { type: 'webnb.highlightWorkspaceLines', cellUri: 'cell:0' }],
                ['highlightWorkspaceLines full', {
                    type: 'webnb.highlightWorkspaceLines',
                    cellUri: 'cell:0',
                    path: 'src/a.ts',
                    ranges: [{ start: 1, end: 2 }, { start: 5, end: 9 }],
                    line: 5
                }],
                ['highlightWorkspaceLines with empty ranges', { type: 'webnb.highlightWorkspaceLines', cellUri: 'cell:0', ranges: [] }],
                // Extra unknown fields are ignored by the guard.
                ['refreshCell with extra field', { type: 'webnb.refreshCell', cellUri: 'cell:0', extra: true }]
            ];

            for (const [label, message] of valid) {
                test(label, () => {
                    assert.strictEqual(isRendererMessage(message), true);
                });
            }
        });

        suite('rejects non-objects and wrong type strings', () => {
            const invalid: [label: string, message: unknown][] = [
                ['null', null],
                ['undefined', undefined],
                ['string', 'webnb.refreshCell'],
                ['number', 42],
                ['boolean', true],
                ['array', []],
                ['empty object', {}],
                ['unknown type string', { type: 'webnb.unknown', cellUri: 'cell:0' }],
                ['non-string type', { type: 7, cellUri: 'cell:0' }]
            ];

            for (const [label, message] of invalid) {
                test(label, () => {
                    assert.strictEqual(isRendererMessage(message), false);
                });
            }
        });

        suite('rejects missing or mistyped fields per variant', () => {
            const invalid: [label: string, message: unknown][] = [
                ['refreshCell without cellUri', { type: 'webnb.refreshCell' }],
                ['refreshCell with numeric cellUri', { type: 'webnb.refreshCell', cellUri: 5 }],
                ['resetCellSource without cellUri', { type: 'webnb.resetCellSource' }],
                ['resetCellSource with numeric cellUri', { type: 'webnb.resetCellSource', cellUri: 5 }],
                ['upsertCellAddon without content', { type: 'webnb.upsertCellAddon', cellUri: 'c', addonType: 't' }],
                ['upsertCellAddon without addonType', { type: 'webnb.upsertCellAddon', cellUri: 'c', content: 'x' }],
                ['upsertCellAddon with non-string content', { type: 'webnb.upsertCellAddon', cellUri: 'c', addonType: 't', content: 7 }],
                ['openWorkspaceFile without path', { type: 'webnb.openWorkspaceFile', cellUri: 'c' }],
                ['openWorkspaceFile with string line', { type: 'webnb.openWorkspaceFile', cellUri: 'c', path: 'p', line: '3' }],
                ['highlightWorkspaceLines without cellUri', { type: 'webnb.highlightWorkspaceLines' }],
                ['highlightWorkspaceLines with numeric path', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', path: 5 }],
                ['highlightWorkspaceLines with string line', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', line: '2' }],
                ['highlightWorkspaceLines with non-array ranges', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', ranges: 'nope' }],
                ['highlightWorkspaceLines with range missing end', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', ranges: [{ start: 1 }] }],
                ['highlightWorkspaceLines with string range start', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', ranges: [{ start: '1', end: 2 }] }],
                ['highlightWorkspaceLines with null range entry', { type: 'webnb.highlightWorkspaceLines', cellUri: 'c', ranges: [null] }],
                ['highlightWorkspaceLines with one bad range among good', {
                    type: 'webnb.highlightWorkspaceLines',
                    cellUri: 'c',
                    ranges: [{ start: 1, end: 2 }, { start: 3 }]
                }]
            ];

            for (const [label, message] of invalid) {
                test(label, () => {
                    assert.strictEqual(isRendererMessage(message), false);
                });
            }
        });
    });
});
