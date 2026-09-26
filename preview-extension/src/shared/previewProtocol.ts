/**
 * The message contract between the preview panel (extension host) and the
 * preview page (src/webview). Types only, no runtime imports, so the node
 * bundle and the DOM bundle can both depend on it.
 *
 * The host owns parsing: it runs the notebook extension's own parseMarkdown
 * and ships cell models across, so the webview never needs `vscode` and the
 * two sides can never disagree about where a cell starts.
 */
import type { Addon, WorkspaceFileSnapshotEntry } from '@webnb/shared/protocol';

export type { Addon, WorkspaceFileSnapshotEntry };

/** One parsed cell, plus where it sits in the source document. */
export interface PreviewCell {
    kind: 'markup' | 'code';
    languageId: string;
    value: string;
    index: number;
    /** 0-based, inclusive source line span -- the basis for scroll sync. */
    startLine: number;
    endLine: number;
    addons: Addon[];
    id?: string;
    autorun?: boolean;
    runonstart?: boolean;
    /** Show only this cell's output; its source starts hidden. */
    hidecode?: boolean;
    /** How tall the output pane should be (`height=` in the fence), as authored. */
    height?: string;
    /** Survives edits: identity for scroll anchoring and remembered answers. */
    stableKey: string;
    /** Changes whenever the cell's rendered content changes: identity for reconciling. */
    contentKey: string;
}

// ---- host -> webview -------------------------------------------------------

/** First message: everything the page needs to render the document. */
export interface PreviewInitMessage {
    type: 'init';
    cells: PreviewCell[];
    /** Display name shown in the preview header. */
    title: string;
    /** Webview URI of the folder holding the notebook, for relative assets. */
    assetBase: string;
    /** Opaque, stable per-document id used to build synthetic cell URIs. */
    documentKey: string;
    scrollSync: boolean;
    autoRunAll: boolean;
    reveal: boolean;
}

/** The document changed on the editor side. */
export interface PreviewUpdateMessage {
    type: 'update';
    cells: PreviewCell[];
}

/** The source editor scrolled; line is 0-based and may be fractional. */
export interface PreviewScrollToLineMessage {
    type: 'scrollToLine';
    line: number;
}

/** The cursor moved; used to mark the cell being edited. */
export interface PreviewActiveLineMessage {
    type: 'activeLine';
    line: number;
}

/**
 * Scroll to a 0-based line even with scroll sync off: the reader followed a
 * `#section` link into this same notebook.
 */
export interface PreviewShowLineMessage {
    type: 'showLine';
    line: number;
}

/** Reply to a `snapshotRequest`. */
export interface PreviewSnapshotResultMessage {
    type: 'snapshotResult';
    requestId: number;
    /** The cell's addons, unchanged: running never fills a `+default`. */
    addons: Addon[];
    files: Record<string, WorkspaceFileSnapshotEntry>;
}

/** A workspace file changed; markup images and file-dependent cells refresh. */
export interface PreviewWorkspaceChangedMessage {
    type: 'workspaceChanged';
    assetVersion: number;
}

export interface PreviewConfigMessage {
    type: 'config';
    scrollSync: boolean;
    autoRunAll: boolean;
    reveal: boolean;
}

/** Re-run every cell (the panel's Refresh command). */
export interface PreviewRunAllMessage {
    type: 'runAll';
}

/**
 * The document is malformed right now (an unclosed fence, a half-typed addon
 * block, a `+id=` reference to a cell that does not exist yet): the parser's
 * warnings, one per line, which the page shows above the cells. `message` is
 * undefined once the document is clean again. (If parsing ever throws, this
 * carries the error and the page keeps the last good parse.)
 */
export interface PreviewParseErrorMessage {
    type: 'parseError';
    message?: string;
}

export type PreviewHostMessage =
    | PreviewInitMessage
    | PreviewUpdateMessage
    | PreviewParseErrorMessage
    | PreviewScrollToLineMessage
    | PreviewActiveLineMessage
    | PreviewShowLineMessage
    | PreviewSnapshotResultMessage
    | PreviewWorkspaceChangedMessage
    | PreviewConfigMessage
    | PreviewRunAllMessage;

// ---- webview -> host -------------------------------------------------------

export interface PreviewReadyMessage {
    type: 'ready';
}

/** Ask the host to snapshot the workspace files a cell's checks reference. */
export interface PreviewSnapshotRequestMessage {
    type: 'snapshotRequest';
    requestId: number;
    language: string;
    source: string;
    addons: Addon[];
}

/** The preview scrolled; align the source editor with this 0-based line. */
export interface PreviewRevealLineMessage {
    type: 'revealLine';
    line: number;
}

/** The reader asked to jump to a cell's source; focus the editor there. */
export interface PreviewJumpToLineMessage {
    type: 'jumpToLine';
    line: number;
}

export interface PreviewOpenWorkspaceFileMessage {
    type: 'openWorkspaceFile';
    path: string;
    line?: number;
}

/**
 * A link clicked in a markup cell, exactly as written: another notebook
 * (`other.webnb#section`, `../x.webnb`, `%20` escapes), a `#section` of this
 * one, or a workspace file. The host resolves it (see links.ts).
 */
export interface PreviewOpenLinkMessage {
    type: 'openLink';
    href: string;
}

export interface PreviewHighlightWorkspaceLinesMessage {
    type: 'highlightWorkspaceLines';
    path?: string;
    ranges?: { start: number; end: number }[];
    line?: number;
}

export type PreviewWebviewMessage =
    | PreviewReadyMessage
    | PreviewSnapshotRequestMessage
    | PreviewRevealLineMessage
    | PreviewJumpToLineMessage
    | PreviewOpenLinkMessage
    | PreviewOpenWorkspaceFileMessage
    | PreviewHighlightWorkspaceLinesMessage;
