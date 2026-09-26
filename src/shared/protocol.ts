/**
 * The wire contract between the extension host, the notebook renderer
 * (src/client/render.ts), and the browser preview harness: the cell-output
 * payload, the messages the renderer posts back, and the runtime guard the
 * extension validates them with.
 *
 * Everything here must stay dependency-free (no vscode, no DOM) — it is
 * imported by all three build targets.
 */

export const WEBNB_OUTPUT_MIME = 'x-application/webnb-output';

export interface Addon {
    type: string;
    content: string;
    id?: string;
}

export interface WorkspaceFileSnapshotEntry {
    path: string;
    /** Workspace-relative path the request resolved to. Only the preview dev
     * server fills this in (its browser-side VFS overlay needs it). */
    resolvedPath?: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

export type RequestedPathBase = 'notebook' | 'workspace';

/** A `file:`/checklist path reference, split into the raw request and how it resolves. */
export interface RequestedPathReference {
    requestPath: string;
    path: string;
    base: RequestedPathBase;
}

/** The output payload the kernel produces and render() consumes. */
export interface WebnbOutputValue {
    source: string;
    language: string;
    addons: Addon[];
    files: Record<string, WorkspaceFileSnapshotEntry>;
    cellUri: string;
    checkedAt: number;
    /** Whether the reader gets the option to reveal solutions (the host's
     * `webnb.allowRevealingSolutions` setting, on by default): a "View
     * solution" button for `+solution` addons and "Show Answer" on MCQ cells.
     * The content stays hidden until the reader clicks. */
    reveal?: boolean;
    /** The cell's `height=` attribute, as the author wrote it; the renderer
     * resolves it through shared/outputHeight. Undefined leaves the output pane
     * at its default size. */
    height?: string;
}

export interface WebNbRefreshCellMessage {
    type: 'webnb.refreshCell';
    cellUri: string;
}

/**
 * The addons the renderer may write back into its notebook: saved multiple
 * choice answers (`+selection`) and terminal history (`+history`). Nothing else
 * the renderer says can reach the file.
 */
export type RendererWritableAddonType = 'selection' | 'history';

const RENDERER_WRITABLE_ADDON_TYPES: ReadonlySet<string> = new Set<RendererWritableAddonType>(['selection', 'history']);

/**
 * Whether the renderer may store `content` as a `+addonType` addon. Both kinds
 * are JSON, so content must parse as JSON; and it may not contain a line that
 * starts a fence, which could close the addon block early when the notebook is
 * saved and turn the rest into cells of its own.
 */
export function isRendererWritableAddon(addonType: unknown, content: unknown): boolean {
    if (typeof addonType !== 'string' || !RENDERER_WRITABLE_ADDON_TYPES.has(addonType) || typeof content !== 'string') {
        return false;
    }
    if (/^[ \t]*(`{3,}|~{3,})/m.test(content)) {
        return false;
    }
    try {
        JSON.parse(content);
        return true;
    } catch {
        return false;
    }
}

export interface WebNbUpsertCellAddonMessage {
    type: 'webnb.upsertCellAddon';
    cellUri: string;
    addonType: RendererWritableAddonType;
    /** JSON text; see isRendererWritableAddon. */
    content: string;
}

/**
 * Asks the kernel to restore the cell's text to its `+default` addon (the
 * starter code). Carries no content on purpose: the kernel resolves the text
 * from the cell's own metadata, so the renderer can never write arbitrary code.
 */
export interface WebNbResetCellSourceMessage {
    type: 'webnb.resetCellSource';
    cellUri: string;
}

export interface WebNbOpenWorkspaceFileMessage {
    type: 'webnb.openWorkspaceFile';
    cellUri: string;
    path: string;
    line?: number;
}

/**
 * Mirrors what a reader is hovering in a walkthrough: the ranges the step shows,
 * narrowed to one line when they point at the code. No path clears the highlight.
 */
export interface WebNbHighlightWorkspaceLinesMessage {
    type: 'webnb.highlightWorkspaceLines';
    cellUri: string;
    path?: string;
    ranges?: { start: number; end: number }[];
    line?: number;
}

export type WebNbRendererMessage = WebNbRefreshCellMessage
    | WebNbUpsertCellAddonMessage
    | WebNbResetCellSourceMessage
    | WebNbOpenWorkspaceFileMessage
    | WebNbHighlightWorkspaceLinesMessage;

export function isRendererMessage(message: unknown): message is WebNbRendererMessage {
    if (!message || typeof message !== 'object') {
        return false;
    }

    const candidate = message as Partial<WebNbRendererMessage>;
    if (candidate.type === 'webnb.refreshCell' || candidate.type === 'webnb.resetCellSource') {
        return typeof candidate.cellUri === 'string';
    }

    if (candidate.type === 'webnb.upsertCellAddon') {
        return typeof candidate.cellUri === 'string' && isRendererWritableAddon(candidate.addonType, candidate.content);
    }

    if (candidate.type === 'webnb.openWorkspaceFile') {
        const openCandidate = candidate as Partial<WebNbOpenWorkspaceFileMessage>;
        return typeof openCandidate.cellUri === 'string'
            && typeof openCandidate.path === 'string'
            && (openCandidate.line === undefined || typeof openCandidate.line === 'number');
    }

    if (candidate.type === 'webnb.highlightWorkspaceLines') {
        const highlightCandidate = candidate as Partial<WebNbHighlightWorkspaceLinesMessage>;
        return typeof highlightCandidate.cellUri === 'string'
            && (highlightCandidate.path === undefined || typeof highlightCandidate.path === 'string')
            && (highlightCandidate.line === undefined || typeof highlightCandidate.line === 'number')
            && (highlightCandidate.ranges === undefined || (Array.isArray(highlightCandidate.ranges)
                && highlightCandidate.ranges.every(range => typeof range?.start === 'number' && typeof range?.end === 'number')));
    }

    return false;
}

/**
 * Kernel -> renderer: forget the in-memory terminal session of these cells.
 * A cell's terminal history lives in the renderer (and in its `+history`
 * addon); after Restore Notebook drops the addon, this makes the renderer
 * drop its copy too, before the restored cells re-render.
 */
export interface WebNbForgetTerminalHistoryMessage {
    type: 'webnb.forgetTerminalHistory';
    cellUris: string[];
}

export const FORGET_TERMINAL_HISTORY_MESSAGE = 'webnb.forgetTerminalHistory';

export function isForgetTerminalHistoryMessage(message: unknown): message is WebNbForgetTerminalHistoryMessage {
    if (!message || typeof message !== 'object') {
        return false;
    }
    const candidate = message as Partial<WebNbForgetTerminalHistoryMessage>;
    return candidate.type === FORGET_TERMINAL_HISTORY_MESSAGE
        && Array.isArray(candidate.cellUris)
        && candidate.cellUris.every(uri => typeof uri === 'string');
}
