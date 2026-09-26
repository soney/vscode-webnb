import * as vscode from 'vscode';
import { errorExecution, logExecution, warnExecution } from './log';
import { deserializeWebnb } from './serializer';

const NOTEBOOK_TYPE = 'web-notebook';
const CONFIG_SECTION = 'webnb';
const LOCK_SETTING = 'lockCellStructure';
/** How long before the same notebook may explain the lock again. */
const NOTICE_THROTTLE_MS = 5000;
/** Runaway guard: more than this many reverts inside the window means a feedback loop. */
const MAX_REVERTS_PER_WINDOW = 8;
const REVERT_BURST_WINDOW_MS = 2000;
/** How close a cell's text edit and a structural change must land to be one Split or Join. */
const SPLIT_JOIN_WINDOW_MS = 1000;

const NOTICE_MESSAGE = 'This notebook\'s cells are locked. You can still edit and run cell contents, but cells cannot be added, removed, or reordered.';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new CellStructureLock());
}

export function deactivate() { }

/** Everything needed to undo one structural change, captured when it happened. */
interface PendingRevert {
    /** Where the change happened; the cells it added start here. */
    start: number;
    addedCount: number;
    /** Copies of the cells it removed, to put back. */
    removed: vscode.NotebookCellData[];
    /** The added cells' texts: a Split's second half. */
    addedTexts: string[];
    /** The removed cells' texts, each after the line break a Join puts in front of it. */
    joinedTexts: string[];
    /** The cell just above the change, whose text a Split or Join also edits. */
    anchor?: vscode.NotebookCell;
    /** When the change arrived. */
    at: number;
}

/** The splice a revert of ours will echo back: where, how many cells out, how many in. */
interface EchoShape {
    start: number;
    removed: number;
    added: number;
}

/** A cell's text now and before its latest edit, for undoing the text half of a Split or Join. */
interface CellText {
    text: string;
    previous: string;
    changedAt: number;
}

/** The runaway guard's limits; tests shorten them. */
export interface CellStructureLockTiming {
    maxRevertsPerWindow: number;
    burstWindowMs: number;
}

interface NotebookLockState {
    /** Reverts not yet applied, newest change first (the order they must be undone in). */
    queue: PendingRevert[];
    /** Serializes each notebook's changes, so their reverts apply in order. */
    chain: Promise<void>;
    burst?: { count: number; since: number };
    resumeTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps learners from changing the shape of a notebook.
 *
 * VS Code has no API to veto a structural notebook edit, so the lock is reactive: when
 * cells are spliced in or out we splice the originals back. Only structural changes are
 * touched, so editing a code example still works, and so does answering a multiple choice
 * question -- that persists as cell metadata, which arrives as a cell change rather than
 * a content change.
 *
 * Three refinements keep the reaction honest:
 * - A reload from disk (a `git pull` with the notebook open) and File: Revert arrive as
 *   the same kind of splice as an edit. When a splice leaves the notebook clean and equal
 *   to the file on disk, it came from the file, and it stands: splicing the stale cells
 *   back would let autosave write them over the newer file.
 * - Split Cell and Join Cells are a text edit plus a splice. Undoing only the splice lost
 *   the code after the cursor (or duplicated the joined text), so the cell's text is put
 *   back along with the cells.
 * - The runaway guard pauses instead of giving up: past the limit, reverts wait for the
 *   burst window to lapse and are then applied together, so the lock ends where it
 *   started even when a held Delete key outruns it.
 */
export class CellStructureLock implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /**
     * Per notebook, the splices our own reverts will echo back, so each echo is ignored.
     * Matched by shape rather than by time: a learner's next Delete can land in the
     * same turn as an echo, and it must still be reverted.
     */
    private readonly _expectedEchoes = new Map<string, EchoShape[]>();
    private readonly _lastNoticeAt = new Map<string, number>();
    private readonly _states = new Map<string, NotebookLockState>();
    /** Text of every cell of every open Web Notebook (keyed by cell document uri). */
    private readonly _cellTexts = new Map<string, CellText>();
    private readonly _timing: CellStructureLockTiming;

    public constructor(timing: Partial<CellStructureLockTiming> = {}) {
        this._timing = { maxRevertsPerWindow: MAX_REVERTS_PER_WINDOW, burstWindowMs: REVERT_BURST_WINDOW_MS, ...timing };
        this._disposables.push(
            vscode.workspace.onDidChangeNotebookDocument(event => this._onDidChangeNotebook(event)),
            vscode.workspace.onDidChangeTextDocument(event => this._onDidChangeTextDocument(event)),
            vscode.workspace.onDidOpenNotebookDocument(notebook => this._trackNotebook(notebook)),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                const key = notebook.uri.toString();
                this._lastNoticeAt.delete(key);
                const state = this._states.get(key);
                if (state?.resumeTimer !== undefined) {
                    clearTimeout(state.resumeTimer);
                }
                this._states.delete(key);
                this._expectedEchoes.delete(key);
                for (const cell of notebook.getCells()) {
                    this._cellTexts.delete(cell.document.uri.toString());
                }
            })
        );
        vscode.workspace.notebookDocuments.forEach(notebook => this._trackNotebook(notebook));
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
        for (const state of this._states.values()) {
            if (state.resumeTimer !== undefined) {
                clearTimeout(state.resumeTimer);
            }
        }
        this._states.clear();
    }

    private _isLocked(notebook: vscode.NotebookDocument): boolean {
        return vscode.workspace
            .getConfiguration(CONFIG_SECTION, notebook.uri)
            .get<boolean>(LOCK_SETTING, true);
    }

    private _trackNotebook(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }
        notebook.getCells().forEach(cell => this._trackCell(cell));
    }

    private _trackCell(cell: vscode.NotebookCell): void {
        const text = cell.document.getText();
        this._cellTexts.set(cell.document.uri.toString(), { text, previous: text, changedAt: 0 });
    }

    private _onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0) {
            return;
        }
        const entry = this._cellTexts.get(event.document.uri.toString());
        if (!entry) {
            return;
        }
        entry.previous = entry.text;
        entry.text = event.document.getText();
        entry.changedAt = Date.now();
    }

    private _state(key: string): NotebookLockState {
        let state = this._states.get(key);
        if (!state) {
            state = { queue: [], chain: Promise.resolve() };
            this._states.set(key, state);
        }
        return state;
    }

    private _onDidChangeNotebook(event: vscode.NotebookDocumentChangeEvent): void {
        const { notebook } = event;
        if (notebook.notebookType !== NOTEBOOK_TYPE || event.contentChanges.length === 0) {
            return;
        }

        for (const change of event.contentChanges) {
            change.removedCells.forEach(cell => this._cellTexts.delete(cell.document.uri.toString()));
            change.addedCells.forEach(cell => this._trackCell(cell));
        }

        const key = notebook.uri.toString();
        if (this._consumeEcho(key, event.contentChanges) || !this._isLocked(notebook)) {
            return;
        }

        // A removed cell keeps a direct reference to its text document, but only until the
        // host tears that document down. Read every cell we need to restore up front, before
        // anything awaits.
        let reverts: PendingRevert[];
        try {
            reverts = buildReverts(notebook, event.contentChanges, Date.now());
        } catch (error) {
            errorExecution('Could not read cells removed from %s, leaving the change in place: %s', key, String(error));
            return;
        }
        if (reverts.length === 0) {
            return;
        }

        // Read now, with the event: a reload leaves the notebook clean, an edit dirty.
        const clean = !notebook.isDirty;
        const state = this._state(key);
        state.chain = state.chain
            .then(() => this._handleChange(notebook, key, reverts, clean))
            .catch(error => errorExecution('Failed to restore locked cell structure for %s: %s', key, String(error)));
    }

    private async _handleChange(notebook: vscode.NotebookDocument, key: string, reverts: PendingRevert[], clean: boolean): Promise<void> {
        // Let the text half of a Split or Join arrive: it can trail the splice by a message.
        await new Promise(resolve => setTimeout(resolve, 0));
        const state = this._state(key);

        if (clean && await this._matchesFileOnDisk(notebook)) {
            // Reloaded from disk, or reverted: the file is the truth now. Reverts
            // still queued describe the structure it replaced, so they go too.
            logExecution('Accepting a structural change to %s: it matches the file on disk', key);
            state.queue = [];
            state.burst = undefined;
            return;
        }

        state.queue.unshift(...reverts);
        await this._drain(notebook, key, state);
    }

    private async _drain(notebook: vscode.NotebookDocument, key: string, state: NotebookLockState): Promise<void> {
        if (state.queue.length === 0 || state.resumeTimer !== undefined) {
            // Empty, or cooling down: the resume timer drains whatever is queued.
            return;
        }
        if (this._isRunawayLoop(key, state)) {
            const wait = Math.max(0, (state.burst?.since ?? Date.now()) + this._timing.burstWindowMs - Date.now());
            state.resumeTimer = setTimeout(() => {
                state.resumeTimer = undefined;
                state.burst = undefined;
                state.chain = state.chain
                    .then(() => this._drain(notebook, key, state))
                    .catch(error => errorExecution('Failed to restore locked cell structure for %s: %s', key, String(error)));
            }, wait + 1);
            return;
        }

        const reverts = state.queue.splice(0);
        if (notebook.isClosed) {
            return;
        }
        try {
            // Each revert's indexes assume every later change has already been undone, so
            // they are applied one at a time, newest first, against a settled document.
            for (const revert of reverts) {
                const echo: EchoShape = { start: revert.start, removed: revert.addedCount, added: revert.removed.length };
                this._expectEcho(key, echo);
                let applied: boolean;
                try {
                    applied = await vscode.workspace.applyEdit(this._revertEdit(notebook, revert));
                } finally {
                    // The change event for our own edit crosses the same RPC channel as the
                    // reply to applyEdit, so it has normally been delivered (and consumed) by
                    // now. Dropping a leftover a turn later keeps a late echo ignored without
                    // letting a stale one swallow a real change.
                    setTimeout(() => this._dropEcho(key, echo), 0);
                }
                if (!applied) {
                    warnExecution('Rejected edit while restoring locked cell structure for %s', key);
                    return;
                }
            }
            this._showNotice(key);
        } catch (error) {
            errorExecution('Failed to restore locked cell structure for %s: %s', key, String(error));
        }
    }

    private _expectEcho(key: string, echo: EchoShape): void {
        const echoes = this._expectedEchoes.get(key) ?? [];
        echoes.push(echo);
        this._expectedEchoes.set(key, echoes);
    }

    private _dropEcho(key: string, echo: EchoShape): void {
        const echoes = this._expectedEchoes.get(key);
        const index = echoes?.indexOf(echo) ?? -1;
        if (echoes && index >= 0) {
            echoes.splice(index, 1);
        }
        if (echoes?.length === 0) {
            this._expectedEchoes.delete(key);
        }
    }

    /** True, and forgotten, when the change is the echo of one of our own reverts. */
    private _consumeEcho(key: string, contentChanges: readonly vscode.NotebookDocumentContentChange[]): boolean {
        const echoes = this._expectedEchoes.get(key);
        if (!echoes || contentChanges.length !== 1) {
            return false;
        }
        const [change] = contentChanges;
        const echo = echoes.find(candidate => candidate.start === change.range.start
            && candidate.removed === change.range.end - change.range.start
            && candidate.added === change.addedCells.length);
        if (!echo) {
            return false;
        }
        this._dropEcho(key, echo);
        return true;
    }

    private _revertEdit(notebook: vscode.NotebookDocument, revert: PendingRevert): vscode.WorkspaceEdit {
        const edit = new vscode.WorkspaceEdit();
        const anchorText = this._anchorTextToRestore(revert);
        if (anchorText !== undefined && revert.anchor) {
            const document = revert.anchor.document;
            edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), anchorText);
        }
        edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(
            new vscode.NotebookRange(revert.start, revert.start + revert.addedCount),
            revert.removed
        )]);
        return edit;
    }

    /**
     * The text the cell above a change had before a Split or Join edited it, or
     * undefined when the change was neither. Split Cell leaves the text before
     * the cursor in the cell and moves the rest into the cells it adds; Join
     * appends the removed cells' texts, each after a line break. Either way the
     * cell's text changed together with the splice, and the combined texts say
     * exactly what it was before.
     */
    private _anchorTextToRestore(revert: PendingRevert): string | undefined {
        if (!revert.anchor || revert.anchor.index < 0) {
            return undefined;
        }
        const entry = this._cellTexts.get(revert.anchor.document.uri.toString());
        if (!entry || entry.text === entry.previous || Math.abs(entry.changedAt - revert.at) > SPLIT_JOIN_WINDOW_MS) {
            return undefined;
        }
        const current = revert.anchor.document.getText();
        const isSplit = revert.removed.length === 0 && revert.addedTexts.length > 0
            && entry.previous === current + revert.addedTexts.join('');
        const isJoin = revert.addedCount === 0 && revert.joinedTexts.length > 0
            && current === entry.previous + revert.joinedTexts.join('');
        return isSplit || isJoin ? entry.previous : undefined;
    }

    private async _matchesFileOnDisk(notebook: vscode.NotebookDocument): Promise<boolean> {
        if (notebook.isUntitled) {
            return false;
        }
        try {
            const onDisk = deserializeWebnb(await vscode.workspace.fs.readFile(notebook.uri)).cells;
            const cells = notebook.getCells();
            return cells.length === onDisk.length && onDisk.every((expected, index) =>
                cells[index].kind === expected.kind
                && cells[index].document.languageId === expected.languageId
                && cells[index].document.getText() === expected.value);
        } catch {
            return false;
        }
    }

    /**
     * Pauses the lock if reverts keep firing, so a lock that somehow fights itself cannot
     * spin: past the limit, the remaining reverts wait until the window lapses and are then
     * applied in one go. It never gives up on them -- that left a held Delete key's cells
     * deleted for good.
     */
    private _isRunawayLoop(key: string, state: NotebookLockState): boolean {
        const now = Date.now();
        if (!state.burst || now - state.burst.since > this._timing.burstWindowMs) {
            state.burst = { count: 1, since: now };
            return false;
        }

        state.burst.count++;
        if (state.burst.count > this._timing.maxRevertsPerWindow) {
            warnExecution('Too many cell structure reverts for %s, pausing the lock briefly', key);
            return true;
        }

        return false;
    }

    private _showNotice(key: string): void {
        const now = Date.now();
        const lastNoticeAt = this._lastNoticeAt.get(key);
        if (lastNoticeAt !== undefined && now - lastNoticeAt < NOTICE_THROTTLE_MS) {
            return;
        }

        this._lastNoticeAt.set(key, now);
        void vscode.window.showWarningMessage(NOTICE_MESSAGE);
    }
}

/**
 * Turns the splices reported by a change event into the reverts that undo them, ordered back
 * to front. Each change's range covers the cells it removed from the document as it stood
 * before that splice; whatever it added sits at the same start index once the splice lands.
 */
function buildReverts(
    notebook: vscode.NotebookDocument,
    contentChanges: readonly vscode.NotebookDocumentContentChange[],
    at: number
): PendingRevert[] {
    const reverts: PendingRevert[] = [];
    for (let index = contentChanges.length - 1; index >= 0; index--) {
        const change = contentChanges[index];
        if (change.addedCells.length === 0 && change.removedCells.length === 0) {
            continue;
        }

        const start = change.range.start;
        reverts.push({
            start,
            addedCount: change.addedCells.length,
            removed: change.removedCells.map(toCellData),
            addedTexts: change.addedCells.map(cell => cell.document.getText()),
            joinedTexts: change.removedCells.map(cell =>
                (cell.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n') + cell.document.getText()),
            // A Split or Join is always a single splice; with several, the cell
            // above one of them is not reliably the one that was edited.
            anchor: contentChanges.length === 1 && start > 0 && start - 1 < notebook.cellCount
                ? notebook.cellAt(start - 1)
                : undefined,
            at
        });
    }

    return reverts;
}

/** Copies a removed cell so it can be put back. Its `index` no longer resolves, so nothing here may read it. */
function toCellData(cell: vscode.NotebookCell): vscode.NotebookCellData {
    const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
    data.metadata = cell.metadata;
    data.outputs = cell.outputs.map(output => new vscode.NotebookCellOutput(
        output.items.map(item => new vscode.NotebookCellOutputItem(item.data, item.mime)),
        output.metadata
    ));
    return data;
}
