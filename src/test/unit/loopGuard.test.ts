import './tddBridge';
import * as assert from 'assert';
import { createLoopFailure, insertLoopGuards } from '../../client/loopGuard';

/** Runs code with the guard's runtime names bound, returning what it pushed. */
function run(code: string, now: () => number = Date.now): unknown[] {
    const out: unknown[] = [];
    new Function('out', '__webnbNow', '__webnbLoopFail', code)(out, now, createLoopFailure());
    return out;
}

suite('client/loopGuard', () => {
    const programs: [name: string, code: string][] = [
        ['labeled loops with continue', "outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; out.push([i, j]); } }"],
        ['a braceless body', 'let n = 0; while (n < 5) n++; out.push(n);'],
        ['a loop as the body of a loop', 'let a = 0, b = 0; while (a++ < 2) while (b < 2) { b++; } out.push(a, b);'],
        ['do-while', 'let k = 0; do k++; while (k < 4); out.push(k);'],
        ['an if without braces', 'let s = 0; if (true) for (const v of [1, 2, 3]) s += v; else s = -1; out.push(s);'],
        ['for-in', 'const o = { x: 1, y: 2 }; for (const key in o) out.push(key);'],
        ['adjacent loops with no spaces', 'let p=0,q=0;while(p<2)p++;while(q<3)q++;out.push(p,q)'],
        ['an empty body', 'let z = 0; for (; z < 3; z++); out.push(z);'],
        ['no semicolons', 'let w = 0\nwhile (w < 2) w++\nout.push(w)'],
    ];

    for (const [name, code] of programs) {
        test(`keeps the meaning of ${name}`, () => {
            assert.deepStrictEqual(run(insertLoopGuards(code)), run(code));
        });
    }

    test('leaves code without loops byte-for-byte alone', () => {
        const code = 'const forward = 1;\nconsole.log(forward);';
        assert.strictEqual(insertLoopGuards(code), code);
    });

    test('leaves code that does not parse alone, so the browser reports the syntax error', () => {
        const code = 'while (x { y(); }';
        assert.strictEqual(insertLoopGuards(code), code);
    });

    test('keeps the text outside loops exactly as written', () => {
        const code = 'const a   =  1 ; // spacing kept\nfor (let i = 0; i < 1; i++) {}\n';
        const guarded = insertLoopGuards(code);
        assert.ok(guarded.startsWith('const a   =  1 ; // spacing kept\n'), guarded);
    });

    test('parses JSX and module syntax when asked', () => {
        assert.ok(insertLoopGuards('const a = <div />; while (x) { y(); }', { jsx: true }).includes('__webnb_c0'));
        assert.ok(insertLoopGuards('import a from "b"; for (;;) break;', { module: true }).includes('__webnb_c0'));
    });

    test('stops a loop that never ends', () => {
        let now = 0;
        assert.throws(() => run(insertLoopGuards('let i = 0; while (i < 10) { }'), () => (now += 1)), /A loop ran for more than 5 seconds/);
    });

    test('lets a deliberate short busy-wait finish', () => {
        // Course 2's event-loop lesson blocks for 1.5 seconds on purpose.
        let now = 0;
        const code = 'const start = __webnbNow(); while (__webnbNow() - start < 1500) { } out.push("done");';
        assert.deepStrictEqual(run(insertLoopGuards(code), () => (now += 1)), ['done']);
    });
});
