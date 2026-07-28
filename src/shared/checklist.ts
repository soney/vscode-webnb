/**
 * The checklist line grammar (`kind: path | value | label`) shared by the
 * renderer (which evaluates checks), the extension host, and the preview
 * (which both discover the files a checklist references).
 */

export type FileChecklistCheckKind = 'directory' | 'file' | 'path' | 'contains' | 'notContains' | 'matches' | 'equals' | 'hasEntry' | 'command';

/** Check kinds whose first field names a workspace path to snapshot.
 * `command` is excluded: its first field is a terminal command, not a path. */
export const PATH_BEARING_CHECK_KINDS: ReadonlySet<FileChecklistCheckKind> = new Set([
    'directory', 'file', 'path', 'contains', 'notContains', 'matches', 'equals', 'hasEntry'
]);

export function stripChecklistLinePrefix(line: string): string {
    return line.trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .trim();
}

/** Splits on `|`, honoring `\|` and `\\` escapes. */
export function splitChecklistFields(value: string): string[] {
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

export function normalizeChecklistCheckKind(kind: string): FileChecklistCheckKind | undefined {
    const normalized = kind.toLowerCase().replace(/[\s_-]+/g, '');
    if (normalized === 'directory' || normalized === 'dir') {
        return 'directory';
    }
    if (normalized === 'file') {
        return 'file';
    }
    if (normalized === 'path' || normalized === 'exists') {
        return 'path';
    }
    if (normalized === 'contains' || normalized === 'include' || normalized === 'includes') {
        return 'contains';
    }
    if (normalized === 'notcontains' || normalized === 'notinclude' || normalized === 'notincludes' || normalized === 'doesnotcontain') {
        return 'notContains';
    }
    if (normalized === 'matches' || normalized === 'match' || normalized === 'regex') {
        return 'matches';
    }
    if (normalized === 'equals' || normalized === 'equal') {
        return 'equals';
    }
    if (normalized === 'hasentry' || normalized === 'entry' || normalized === 'containsentry') {
        return 'hasEntry';
    }
    if (normalized === 'command' || normalized === 'cmd' || normalized === 'ran') {
        return 'command';
    }
    return undefined;
}
