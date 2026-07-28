/**
 * Discovers which workspace files a cell references (from `+files` addons,
 * checklist lines, test-addon source, and walkthrough `file:` lines) and
 * normalizes/resolves the requested paths. This is the single source of truth
 * the extension host, the renderer, and the preview all snapshot from — if it
 * drifts, the preview harness stops testing what VS Code actually does.
 */
import type { Addon, RequestedPathReference } from './protocol';
import {
    FILE_SNAPSHOT_ADDON_TYPES,
    isExternalCheckLanguage,
    isScriptAddonType,
    isWalkthroughLanguage,
    normalizeAddonType
} from './addons';
import {
    PATH_BEARING_CHECK_KINDS,
    normalizeChecklistCheckKind,
    splitChecklistFields,
    stripChecklistLinePrefix
} from './checklist';

export const MAX_FILE_SNAPSHOT_BYTES = 1024 * 1024;
export const RELATIVE_PATHS_ERROR = 'File checks must use relative paths without ".." segments.';

export function fileTooLargeError(maxBytes: number = MAX_FILE_SNAPSHOT_BYTES): string {
    return `File is larger than ${maxBytes} bytes, so its contents were not loaded.`;
}

/** One `path` line inside a `+files` addon; strips list markers and backticks. */
export function parseRequestedPathLine(line: string): string | undefined {
    let path = line.trim();
    if (!path || path.startsWith('#')) {
        return undefined;
    }

    path = path.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
    const backtickMatch = path.match(/^`([^`]+)`$/);
    if (backtickMatch) {
        path = backtickMatch[1].trim();
    }

    return path || undefined;
}

export function parseRequestedPathReference(requestPath: string): RequestedPathReference {
    const trimmed = requestPath.trim().replace(/\\/g, '/');
    const workspaceScopedMatch = trimmed.match(/^workspace\s*:\s*(.*)$/i);
    if (workspaceScopedMatch) {
        const scopedPath = workspaceScopedMatch[1].trim();
        return {
            requestPath: `workspace:${scopedPath}`,
            path: scopedPath,
            base: 'workspace'
        };
    }

    return {
        requestPath: trimmed,
        path: trimmed,
        base: 'notebook'
    };
}

export function getRequestedChecklistFilePaths(source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    for (const rawLine of source.split(/\r?\n/g)) {
        const line = stripChecklistLinePrefix(rawLine);
        if (!line || line.startsWith('#')) {
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
            continue;
        }

        const kind = normalizeChecklistCheckKind(line.slice(0, colonIndex));
        const fields = splitChecklistFields(line.slice(colonIndex + 1));
        const path = fields[0];
        if (path && kind && PATH_BEARING_CHECK_KINDS.has(kind)) {
            paths.push(parseRequestedPathReference(path));
        }
    }

    return paths;
}

export function getRequestedFilePathsFromTestSource(source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    const patterns = [
        /\bcheck\s*\.\s*(?:file|directory|path|exists)\s*\(\s*(['"`])([^'"`]+)\1/g,
        /\bfile\s*\(\s*(['"`])([^'"`]+)\1/g
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            if (match[2]) {
                paths.push(parseRequestedPathReference(match[2]));
            }
        }
    }

    return paths;
}

export function getRequestedWalkthroughFilePaths(source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    for (const rawLine of source.split(/\r?\n/g)) {
        const match = rawLine.match(/^file\s*:\s*(.+)$/i);
        if (match && match[1].trim()) {
            paths.push(parseRequestedPathReference(match[1].trim()));
        }
    }
    return paths;
}

/** Returns the de-duplicated set of file references a cell needs snapshotted. */
export function getRequestedFilePaths(addons: Addon[], languageId: string, source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    for (const addon of addons) {
        if (!FILE_SNAPSHOT_ADDON_TYPES.has(normalizeAddonType(addon.type))) {
            continue;
        }

        for (const line of addon.content.split(/\r?\n/g)) {
            const path = parseRequestedPathLine(line);
            if (path) {
                paths.push(parseRequestedPathReference(path));
            }
        }
    }

    if (isExternalCheckLanguage(languageId)) {
        paths.push(...getRequestedChecklistFilePaths(source));
        for (const addon of addons) {
            if (isScriptAddonType(addon.type)) {
                paths.push(...getRequestedFilePathsFromTestSource(addon.content));
            }
        }
    }

    if (isWalkthroughLanguage(languageId)) {
        paths.push(...getRequestedWalkthroughFilePaths(source));
    }

    const uniquePaths = new Map<string, RequestedPathReference>();
    for (const pathRef of paths) {
        uniquePaths.set(pathRef.requestPath, pathRef);
    }
    return Array.from(uniquePaths.values());
}

/**
 * Normalizes a snapshot path for resolution against the workspace: forward
 * slashes, no empty/`.` segments. Rejects absolute paths and `..` so checks
 * can never read outside the workspace.
 */
export function normalizeWorkspacePath(path: string): string | undefined {
    const normalizedSlashes = path.trim().replace(/\\/g, '/');
    if (!normalizedSlashes || normalizedSlashes.startsWith('/') || /^[A-Za-z]:\//.test(normalizedSlashes)) {
        return undefined;
    }

    const parts = normalizedSlashes
        .split('/')
        .filter(part => part && part !== '.');

    if (parts.length === 0 || parts.some(part => part === '..')) {
        return undefined;
    }

    return parts.join('/');
}

/**
 * Where a normalized path resolves: `workspace:`-scoped requests resolve from
 * the workspace root, everything else from the notebook's own directory.
 */
export function resolveWorkspaceRelativePath(
    reference: Pick<RequestedPathReference, 'base'>,
    normalizedPath: string,
    notebookRelativeDir: string
): string {
    return reference.base === 'workspace' || !notebookRelativeDir
        ? normalizedPath
        : `${notebookRelativeDir}/${normalizedPath}`;
}
