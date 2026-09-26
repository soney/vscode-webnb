import './tddBridge';
import * as assert from 'assert';
import { deepEqual } from '../../client/utils';

suite('client/utils deepEqual', () => {
    test('a failed comparison inside a Set search is not remembered as equal', () => {
        const x = { k: 1 };
        const y = { k: 2 };
        const yCopy = { k: 2 };
        // Matching x against the second Set tries yCopy first and fails; the
        // Sets are still equal. Comparing x with yCopy again afterwards must
        // still fail rather than hit a remembered "equal".
        const left = [new Set([x, y]), x];
        const right = [new Set([yCopy, { k: 1 }]), yCopy];
        assert.strictEqual(deepEqual(left, right), false);
    });

    test('equal Sets of objects are still equal', () => {
        assert.strictEqual(deepEqual(new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }])), true);
    });

    test('circular structures terminate', () => {
        const a: Record<string, unknown> = { name: 'a' };
        a.self = a;
        const b: Record<string, unknown> = { name: 'a' };
        b.self = b;
        assert.strictEqual(deepEqual(a, b), true);
    });
});
