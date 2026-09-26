/**
 * The tdd names (`suite`, `test`, `setup`, `teardown`, `suiteSetup`,
 * `suiteTeardown`) on top of mocha's default bdd UI, for the extension-host
 * tests. Like unit/tddBridge.ts, which covers only `suite`/`test`, it does
 * nothing when the tdd UI is already in place (vscode-test). Imported for its
 * side effect at the top of every host test file.
 */
const globalScope = globalThis as unknown as Record<string, unknown>;
const aliases: [tdd: string, bdd: string][] = [
    ['suite', 'describe'],
    ['test', 'it'],
    ['setup', 'beforeEach'],
    ['teardown', 'afterEach'],
    ['suiteSetup', 'before'],
    ['suiteTeardown', 'after']
];
for (const [tdd, bdd] of aliases) {
    if (typeof globalScope[tdd] !== 'function' && typeof globalScope[bdd] === 'function') {
        globalScope[tdd] = globalScope[bdd];
    }
}

export {};
