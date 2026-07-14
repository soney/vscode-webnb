/**
 * Discovers which workspace files a cell's checks reference, so the kernel can
 * snapshot them. This is a faithful port of the relevant helpers in the
 * extension's webnbProvider.ts (the parts that compute requested paths). Disk
 * resolution happens server-side; this only figures out *what* to ask for.
 */
import { getWalkthroughFilePaths } from '../../src/client/walkthrough';
import type { Addon, SnapshotRequest } from './types';

const FILE_SNAPSHOT_ADDON_TYPES = new Set(['file', 'files', 'workspace-files']);
const EXTERNAL_CHECK_LANGUAGES = new Set(['external', 'checklist']);
const WALKTHROUGH_LANGUAGES = new Set(['walkthrough']);

function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

function isExternalCheckLanguage(languageId: string): boolean {
    return EXTERNAL_CHECK_LANGUAGES.has(languageId.toLowerCase());
}

function isScriptAddonType(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'test' || normalizedType === 'javascript' || normalizedType === 'js';
}

function parseRequestedPathLine(line: string): string | undefined {
    let p = line.trim();
    if (!p || p.startsWith('#')) {
        return undefined;
    }
    p = p.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
    const backtickMatch = p.match(/^`([^`]+)`$/);
    if (backtickMatch) {
        p = backtickMatch[1].trim();
    }
    return p || undefined;
}

export function parseRequestedPathReference(requestPath: string): SnapshotRequest {
    const trimmed = requestPath.trim().replace(/\\/g, '/');
    const workspaceScopedMatch = trimmed.match(/^workspace\s*:\s*(.*)$/i);
    if (workspaceScopedMatch) {
        const scopedPath = workspaceScopedMatch[1].trim();
        return { requestPath: `workspace:${scopedPath}`, path: scopedPath, base: 'workspace' };
    }
    return { requestPath: trimmed, path: trimmed, base: 'notebook' };
}

function stripChecklistLinePrefix(line: string): string {
    return line.trim().replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
}

function splitChecklistFields(value: string): string[] {
    const fields: string[] = [];
    let current = '';
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === '\\') {
            const nextChar = value[index + 1];
            if (nextChar === '|' || nextChar === '\\') {
                current += nextChar;
                index++;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '|') {
            fields.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    fields.push(current.trim());
    return fields;
}

function normalizeChecklistCheckKind(kind: string): string {
    const normalized = kind.toLowerCase().replace(/[\s_-]+/g, '');
    if (normalized === 'dir') { return 'directory'; }
    if (normalized === 'exists') { return 'path'; }
    if (normalized === 'include' || normalized === 'includes') { return 'contains'; }
    if (normalized === 'notinclude' || normalized === 'notincludes' || normalized === 'doesnotcontain') { return 'notcontains'; }
    if (normalized === 'match' || normalized === 'regex') { return 'matches'; }
    if (normalized === 'equal') { return 'equals'; }
    if (normalized === 'entry' || normalized === 'containsentry') { return 'hasentry'; }
    return normalized;
}

function getRequestedChecklistFilePaths(source: string): SnapshotRequest[] {
    const paths: SnapshotRequest[] = [];
    for (const rawLine of source.split(/\r?\n/g)) {
        const line = stripChecklistLinePrefix(rawLine);
        if (!line || line.startsWith('#')) { continue; }
        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) { continue; }
        const kind = normalizeChecklistCheckKind(line.slice(0, colonIndex));
        const fields = splitChecklistFields(line.slice(colonIndex + 1));
        const p = fields[0];
        if (p && ['directory', 'file', 'path', 'contains', 'notcontains', 'matches', 'equals', 'hasentry'].includes(kind)) {
            paths.push(parseRequestedPathReference(p));
        }
    }
    return paths;
}

function getRequestedFilePathsFromTestSource(source: string): SnapshotRequest[] {
    const paths: SnapshotRequest[] = [];
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

/** Returns the de-duplicated set of file references a cell needs snapshotted. */
export function getRequestedFilePaths(addons: Addon[], languageId: string, source: string): SnapshotRequest[] {
    const paths: SnapshotRequest[] = [];
    for (const addon of addons) {
        if (!FILE_SNAPSHOT_ADDON_TYPES.has(normalizeAddonType(addon.type))) { continue; }
        for (const line of addon.content.split(/\r?\n/g)) {
            const p = parseRequestedPathLine(line);
            if (p) { paths.push(parseRequestedPathReference(p)); }
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

    if (WALKTHROUGH_LANGUAGES.has(languageId.toLowerCase())) {
        paths.push(...getWalkthroughFilePaths(source).map(parseRequestedPathReference));
    }

    const unique = new Map<string, SnapshotRequest>();
    for (const ref of paths) {
        unique.set(ref.requestPath, ref);
    }
    return Array.from(unique.values());
}
