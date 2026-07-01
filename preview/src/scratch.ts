/**
 * Per-notebook scratch store for browser-side edits that must never touch disk:
 *  - `code` overrides: edited source for a cell, keyed by a stable cell key.
 *  - `selection` overrides: MCQ selections, persisted as the cell's `selection` addon.
 *
 * Everything lives in localStorage so it survives reloads (the user opted into
 * persistence). Disk is never written.
 */

const STORAGE_PREFIX = 'webnb:scratch:v1:';

interface NotebookScratch {
    code: Record<string, string>;
    selection: Record<string, string>;
}

function emptyScratch(): NotebookScratch {
    return { code: {}, selection: {} };
}

export class ScratchStore {
    private readonly storageKey: string;
    private data: NotebookScratch;
    private listeners = new Set<() => void>();

    constructor(workspaceId: string, notebookPath: string) {
        this.storageKey = `${STORAGE_PREFIX}${workspaceId}:${notebookPath}`;
        this.data = this.load();
    }

    private load(): NotebookScratch {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) { return emptyScratch(); }
            const parsed = JSON.parse(raw) as Partial<NotebookScratch>;
            return { code: parsed.code || {}, selection: parsed.selection || {} };
        } catch {
            return emptyScratch();
        }
    }

    private save(): void {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        } catch {
            // ignore quota/unavailable
        }
        for (const listener of this.listeners) { listener(); }
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // ---- code overrides ----------------------------------------------------

    getCode(cellKey: string): string | undefined {
        return Object.prototype.hasOwnProperty.call(this.data.code, cellKey)
            ? this.data.code[cellKey]
            : undefined;
    }

    setCode(cellKey: string, source: string): void {
        this.data.code[cellKey] = source;
        this.save();
    }

    clearCode(cellKey: string): void {
        if (Object.prototype.hasOwnProperty.call(this.data.code, cellKey)) {
            delete this.data.code[cellKey];
            this.save();
        }
    }

    hasCode(cellKey: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.data.code, cellKey);
    }

    editedCellKeys(): string[] {
        return Object.keys(this.data.code);
    }

    clearAllCode(): void {
        this.data.code = {};
        this.save();
    }

    // ---- MCQ selection overrides ------------------------------------------

    getSelection(cellKey: string): string | undefined {
        return this.data.selection[cellKey];
    }

    setSelection(cellKey: string, content: string): void {
        this.data.selection[cellKey] = content;
        this.save();
    }
}
