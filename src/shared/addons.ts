/**
 * Addon-type and language-id predicates shared by the extension host, the
 * renderer, and the preview. These normalize authoring variants (`+test`,
 * `Test`, `js`) to one canonical form so every consumer agrees on what an
 * addon is.
 */
import type { Addon } from './protocol';

export const FILE_SNAPSHOT_ADDON_TYPES = new Set(['file', 'files', 'workspace-files']);

const EXTERNAL_CHECK_LANGUAGES = new Set(['external', 'checklist']);
const WALKTHROUGH_LANGUAGES = new Set(['walkthrough']);

export function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

export function isScriptAddonType(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'test' || normalizedType === 'javascript' || normalizedType === 'js';
}

export function isSolutionAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'solution';
}

export function isHtmlAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'html';
}

export function isCssAddon(type: string | undefined): boolean {
    return normalizeAddonType(type) === 'css';
}

export function isTerminalAddon(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'terminal' || normalizedType === 'xterm';
}

export function isExternalCheckLanguage(languageId: string): boolean {
    return EXTERNAL_CHECK_LANGUAGES.has(languageId.toLowerCase());
}

export function isWalkthroughLanguage(languageId: string): boolean {
    return WALKTHROUGH_LANGUAGES.has(languageId.toLowerCase());
}

/** Cells that render an interactive widget and should run on notebook open. */
export function isAutoWidgetLanguage(languageId: string): boolean {
    return languageId === 'mcq' || isExternalCheckLanguage(languageId) || isWalkthroughLanguage(languageId);
}

/** The cell attributes that decide whether it runs by itself. */
export interface RunOnOpenCell {
    languageId: string;
    autorun?: boolean;
    runonstart?: boolean;
    hidecode?: boolean;
}

/**
 * Cells that run without the reader pressing anything.
 *
 * `hidecode` is in here because a cell whose source is hidden has nothing worth
 * pressing Run on: the reader cannot see what they would be running. Hiding the
 * code and running it are the same intent -- show me the output, not the
 * machinery -- so the flag carries both.
 *
 * `runonstart` is the one that can be spent: it fires once per notebook
 * session, so callers that track that pass `runOnStartAlreadyDone`.
 */
export function runsOnOpen(cell: RunOnOpenCell, options?: { runOnStartAlreadyDone?: boolean }): boolean {
    if (cell.autorun || cell.hidecode || isAutoWidgetLanguage(cell.languageId)) {
        return true;
    }
    return !!cell.runonstart && !options?.runOnStartAlreadyDone;
}

export function getAddonContent(addons: Addon[], type: string): string | undefined {
    const match = addons.find(addon => normalizeAddonType(addon.type) === normalizeAddonType(type));
    return match?.content;
}

export function upsertAddon(addons: Addon[], type: string, content: string): Addon[] {
    const normalizedType = normalizeAddonType(type);
    const existingIndex = addons.findIndex(addon => normalizeAddonType(addon.type) === normalizedType);
    if (existingIndex >= 0) {
        const updated = addons.slice();
        updated[existingIndex] = {
            ...updated[existingIndex],
            type,
            content
        };
        return updated;
    }

    return [...addons, { type, content }];
}

/**
 * Fills an empty `default` addon with the cell's current source, so "reset to
 * default" can restore what the author originally shipped. Returns `changed`
 * so the extension can write the capture back into cell metadata.
 */
export function getDefaultCaptureAddons(addons: Addon[], source: string): { addons: Addon[]; changed: boolean } {
    const defaultIndex = addons.findIndex(addon => normalizeAddonType(addon.type) === 'default');
    if (defaultIndex < 0) {
        return { addons, changed: false };
    }

    const existing = addons[defaultIndex];
    if (existing.content.trim().length > 0) {
        return { addons, changed: false };
    }

    const updated = addons.slice();
    updated[defaultIndex] = {
        ...existing,
        content: source
    };

    return { addons: updated, changed: true };
}
