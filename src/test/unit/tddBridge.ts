/**
 * `npm run test:unit` runs mocha with its default `bdd` UI (describe/it),
 * while these tests — matching the style of src/test/extension.test.ts, which
 * runs under vscode-test's `tdd` UI — use `suite`/`test`. Bridge the tdd names
 * onto the bdd globals when they are missing so the same files work in both
 * runners. Imported for its side effect at the top of every unit test file.
 */
const globalScope = globalThis as unknown as Record<string, unknown>;
if (typeof globalScope.suite !== 'function' && typeof globalScope.describe === 'function') {
    globalScope.suite = globalScope.describe;
    globalScope.test = globalScope.it;
}

export {};
