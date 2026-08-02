import './tddBridge';
import * as assert from 'assert';
import { parseOutputHeight } from '../../shared/outputHeight';

suite('shared/outputHeight', () => {
    suite('parseOutputHeight', () => {
        const heights: [raw: string, expected: string][] = [
            ['300', '300px'],
            ['0', '0px'],
            ['12.5', '12.5px'],
            ['300px', '300px'],
            ['20em', '20em'],
            ['1.5rem', '1.5rem'],
            ['50vh', '50vh'],
            ['100%', '100%'],
            ['auto', 'auto'],
            // Authors write fences by hand: tolerate spacing and casing.
            ['  240PX  ', '240px'],
            ['Auto', 'auto']
        ];

        for (const [raw, expected] of heights) {
            test(`${JSON.stringify(raw)} -> ${expected}`, () => {
                assert.strictEqual(parseOutputHeight(raw), expected);
            });
        }

        // Nothing here is a length, so the pane keeps its default size rather
        // than taking a broken value into its style attribute.
        const ignored = ['', '   ', 'tall', '300 px', '-40', '40 px', 'calc(100% - 10px)', '300pxx', 'px'];
        for (const raw of ignored) {
            test(`${JSON.stringify(raw)} is ignored`, () => {
                assert.strictEqual(parseOutputHeight(raw), undefined);
            });
        }

        test('a missing attribute is ignored', () => {
            assert.strictEqual(parseOutputHeight(undefined), undefined);
        });
    });
});
