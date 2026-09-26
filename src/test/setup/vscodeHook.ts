/**
 * Loaded by `npm run test:unit` (mocha --require) before any test: makes
 * `require('vscode')` resolve to the stub in ../host/vscodeStub, so the
 * extension-host modules and src/test/extension.test.ts run under plain mocha
 * (and in CI) instead of only inside a VS Code instance.
 */
import Module = require('module');

const stubPath = require.resolve('../host/vscodeStub');
type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const moduleWithResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename = moduleWithResolver._resolveFilename;

moduleWithResolver._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    if (request === 'vscode') {
        return stubPath;
    }
    return originalResolveFilename.call(this, request, ...rest);
};
