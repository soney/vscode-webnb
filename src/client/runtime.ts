/**
 * Shims for the js/node/react cell runtime: the tiny `require`, `process`,
 * and `path` stand-ins evaluated cell code can use. Nothing here touches a
 * real filesystem or process — it is all simulated for exercises.
 */
import * as React from 'react';
import { marked } from 'marked';

export const pathModule = {
    join: (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    basename: (value: string) => value.split('/').filter(Boolean).pop() || '',
    dirname: (value: string) => {
        const parts = value.split('/').filter(Boolean);
        return parts.length <= 1 ? '.' : parts.slice(0, -1).join('/');
    },
    extname: (value: string) => {
        const base = value.split('/').filter(Boolean).pop() || '';
        const dotIndex = base.lastIndexOf('.');
        return dotIndex <= 0 ? '' : base.slice(dotIndex);
    }
};

export function createNodeProcess() {
    return {
        env: {},
        argv: [],
        versions: { node: 'webnb-simulated' },
        platform: 'webnb',
        cwd: () => '/workspace'
    };
}

/** The `require` cell code sees; only the notebook-provided modules resolve. */
export function createRuntimeRequire(reactDom: unknown): (moduleName: string) => unknown {
    return (moduleName: string) => {
        if (moduleName === 'react') {
            return React;
        }
        if (moduleName === 'react-dom/client') {
            return reactDom;
        }
        if (moduleName === 'marked') {
            return { marked };
        }
        if (moduleName === 'path') {
            return pathModule;
        }

        throw new Error(`Module '${moduleName}' is not available in this web notebook runtime.`);
    };
}
