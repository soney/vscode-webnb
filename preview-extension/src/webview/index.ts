/**
 * The .webnb source preview page.
 *
 * The text editor is the source of truth: the host re-parses on every change
 * and sends cells across; this view reconciles the ones that actually changed
 * and keeps its scroll position lined up with the editor's.
 */
import previewCss from './preview.css';
import highlightCss from '@webnb/client/syntaxHighlight.css';
import { CellView, type CellDeps } from './cell';
import type { WorkspaceFileSnapshotEntry } from '@webnb/shared/protocol';
import type {
    Addon,
    PreviewCell,
    PreviewHostMessage,
    PreviewWebviewMessage
} from '../shared/previewProtocol';

const vscode = acquireVsCodeApi();

/** How long to ignore our own scrolling after applying a sync from the editor. */
const SYNC_QUIET_MS = 220;
/** Debounce for reporting preview scrolls back to the editor. */
const REVEAL_DEBOUNCE_MS = 60;

interface PersistedState {
    /** Lets the host re-bind a restored panel to its document after a reload. */
    uri?: string;
    selections?: Record<string, string>;
}

/** A cell run waiting on the host's file snapshot. */
type PendingSnapshot = (value: { addons: Addon[]; files: Record<string, WorkspaceFileSnapshotEntry> }) => void;

class PreviewApp {
    private readonly root: HTMLElement;
    private headerTitle!: HTMLElement;
    private scrollEl!: HTMLElement;
    private cellsEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private errorEl!: HTMLElement;

    private views: CellView[] = [];
    private assets = { base: '', version: 0 };
    private documentKey = '';
    private scrollSync = true;
    private autoRunAll = false;
    private revealSolutions = true;
    private initialized = false;

    private selections: Record<string, string>;
    private pending = new Map<number, PendingSnapshot>();
    private nextRequestId = 1;

    private quietUntil = 0;
    private revealTimer?: number;

    constructor(root: HTMLElement) {
        this.root = root;
        const state = (vscode.getState() ?? {}) as PersistedState;
        this.selections = state.selections ?? {};
    }

    start(): void {
        this.buildChrome();
        window.addEventListener('message', event => this.onHostMessage(event.data as PreviewHostMessage));
        this.post({ type: 'ready' });
    }

    // ---- chrome ------------------------------------------------------------

    private buildChrome(): void {
        // The renderer's highlight stylesheet first: its class-scoped rules style
        // the read-only cell sources and the fenced code inside markup cells, both
        // of which live in the page rather than in an output's shadow root.
        const rendererStyle = document.createElement('style');
        rendererStyle.textContent = highlightCss;
        document.head.append(rendererStyle);

        const style = document.createElement('style');
        style.textContent = previewCss;
        document.head.append(style);

        this.root.innerHTML = `
            <div class="wnb-root">
                <header class="wnb-header">
                    <span class="wnb-title"></span>
                    <span class="wnb-spacer"></span>
                    <span class="wnb-status"></span>
                    <button type="button" class="wnb-header-button wnb-run-all">Run all</button>
                </header>
                <div class="wnb-parse-error" hidden></div>
                <div class="wnb-scroll"><div class="wnb-cells"></div></div>
            </div>
        `;

        this.headerTitle = this.root.querySelector('.wnb-title')!;
        this.scrollEl = this.root.querySelector('.wnb-scroll')!;
        this.cellsEl = this.root.querySelector('.wnb-cells')!;
        this.statusEl = this.root.querySelector('.wnb-status')!;
        this.errorEl = this.root.querySelector('.wnb-parse-error')!;

        this.root.querySelector('.wnb-run-all')!.addEventListener('click', () => this.runAll());
        this.scrollEl.addEventListener('scroll', () => this.onPreviewScroll(), { passive: true });
    }

    /** Persist enough for VS Code to hand a restored panel back to its document. */
    private saveState(): void {
        vscode.setState({ uri: this.documentKey, selections: this.selections } satisfies PersistedState);
    }

    private runAll(): void {
        for (const view of this.views) {
            void view.run();
        }
    }

    // ---- host messages -----------------------------------------------------

    private post(message: PreviewWebviewMessage): void {
        vscode.postMessage(message);
    }

    /**
     * The panel moved to another notebook. Nothing from the old one survives:
     * cell keys are per-document, so reconciling across the two could reuse a
     * cell of the file being left.
     */
    private clearDocument(): void {
        for (const view of this.views) {
            view.dispose();
        }
        this.views = [];
        this.cellsEl.replaceChildren();
        this.pending.clear();
        this.scrollEl.scrollTop = 0;
        this.errorEl.textContent = '';
        this.errorEl.hidden = true;
    }

    private onHostMessage(message: PreviewHostMessage): void {
        switch (message.type) {
            case 'init':
                if (this.initialized && message.documentKey !== this.documentKey) {
                    this.clearDocument();
                }
                this.documentKey = message.documentKey;
                // Mutated in place: every CellView holds this same object.
                this.assets.base = message.assetBase;
                this.scrollSync = message.scrollSync;
                this.autoRunAll = message.autoRunAll;
                this.revealSolutions = message.reveal;
                this.headerTitle.textContent = message.title;
                document.title = `Preview ${message.title}`;
                this.initialized = true;
                this.saveState();
                this.render(message.cells);
                return;

            case 'update':
                if (this.initialized) {
                    this.render(message.cells);
                }
                return;

            case 'parseError':
                this.errorEl.textContent = message.message ?? '';
                this.errorEl.hidden = !message.message;
                return;

            case 'config': {
                this.scrollSync = message.scrollSync;
                this.autoRunAll = message.autoRunAll;
                const revealChanged = this.revealSolutions !== message.reveal;
                this.revealSolutions = message.reveal;
                if (revealChanged) {
                    for (const view of this.views) {
                        view.rerunIfRan();
                    }
                }
                return;
            }

            case 'runAll':
                this.runAll();
                return;

            case 'scrollToLine':
                if (this.scrollSync) {
                    this.applyScrollToLine(message.line);
                }
                return;

            case 'activeLine':
                this.markActiveLine(message.line);
                return;

            case 'workspaceChanged':
                this.assets.version = message.assetVersion;
                for (const view of this.views) {
                    view.refreshAssets();
                    if (view.dependsOnWorkspace()) {
                        void view.run();
                    }
                }
                return;

            case 'snapshotResult': {
                const resolve = this.pending.get(message.requestId);
                if (resolve) {
                    this.pending.delete(message.requestId);
                    resolve({ addons: message.addons, files: message.files });
                }
                return;
            }
        }
    }

    // ---- rendering ---------------------------------------------------------

    private selectionKey(stableKey: string): string {
        return `${this.documentKey} ${stableKey}`;
    }

    private makeDeps(): CellDeps {
        return {
            assets: this.assets,
            cellUri: (model: PreviewCell) => `webnb-preview://${this.documentKey}#${model.stableKey}`,
            requestSnapshot: (language, source, addons) => this.requestSnapshot(language, source, addons),
            reveal: () => this.revealSolutions,
            // Scoped to the document: a panel that moves between notebooks must
            // not answer one file's questions with another file's answers.
            getSelection: key => this.selections[this.selectionKey(key)],
            setSelection: (key, content) => {
                this.selections[this.selectionKey(key)] = content;
                this.saveState();
            },
            jumpToLine: line => this.post({ type: 'jumpToLine', line }),
            openWorkspaceFile: (path, line) => this.post({ type: 'openWorkspaceFile', path, line }),
            highlightWorkspaceLines: message => this.post({ type: 'highlightWorkspaceLines', ...message })
        };
    }

    private requestSnapshot(
        language: string,
        source: string,
        addons: Addon[]
    ): Promise<{ addons: Addon[]; files: Record<string, WorkspaceFileSnapshotEntry> }> {
        const requestId = this.nextRequestId++;
        return new Promise(resolve => {
            this.pending.set(requestId, resolve);
            this.post({ type: 'snapshotRequest', requestId, language, source, addons });
            // A dropped reply must not wedge the cell in "running" forever.
            window.setTimeout(() => {
                if (this.pending.delete(requestId)) {
                    resolve({ addons, files: {} });
                }
            }, 5000);
        });
    }

    /**
     * Reconcile. Cells whose content is unchanged keep their exact DOM node --
     * and therefore their live output, terminal and MCQ state -- so typing in
     * one cell never resets the rest of the notebook.
     */
    private render(cells: PreviewCell[]): void {
        const anchor = this.captureAnchor();

        const pool = new Map<string, CellView[]>();
        for (const view of this.views) {
            const bucket = pool.get(view.key);
            if (bucket) {
                bucket.push(view);
            } else {
                pool.set(view.key, [view]);
            }
        }
        const ranBefore = new Map<string, boolean>();
        for (const view of this.views) {
            ranBefore.set(view.stableKey, view.ran);
        }

        const deps = this.makeDeps();
        const next: CellView[] = [];
        const fresh: CellView[] = [];
        const reused = new Set<CellView>();

        for (const model of cells) {
            const existing = pool.get(model.contentKey)?.shift();
            if (existing) {
                existing.adoptPosition(model);
                reused.add(existing);
                next.push(existing);
                continue;
            }

            const view = new CellView(model, deps);
            next.push(view);
            fresh.push(view);
        }

        for (const view of this.views) {
            if (!reused.has(view)) {
                view.dispose();
            }
        }

        this.views = next;
        this.syncDom(next.map(view => view.element));
        this.statusEl.textContent = `${cells.length} cell${cells.length === 1 ? '' : 's'}`;

        // Let the new nodes lay out before running them, so outputs measure right.
        requestAnimationFrame(() => {
            if (this.views !== next) {
                return;
            }
            for (const view of fresh) {
                if (this.autoRunAll || ranBefore.get(view.stableKey)) {
                    void view.run();
                } else {
                    view.autorunIfNeeded();
                }
            }
            this.restoreAnchor(anchor);
        });
    }

    /** Move existing nodes into the new order without recreating any of them. */
    private syncDom(desired: HTMLElement[]): void {
        const wanted = new Set<Element>(desired);
        for (const child of Array.from(this.cellsEl.children)) {
            if (!wanted.has(child)) {
                child.remove();
            }
        }

        let ref: ChildNode | null = this.cellsEl.firstChild;
        for (const element of desired) {
            if (ref === element) {
                ref = ref.nextSibling;
            } else {
                this.cellsEl.insertBefore(element, ref);
            }
        }
    }

    // ---- scroll sync -------------------------------------------------------

    private topOf(view: CellView): number {
        const containerTop = this.scrollEl.getBoundingClientRect().top;
        return view.element.getBoundingClientRect().top - containerTop + this.scrollEl.scrollTop;
    }

    /** Scroll offset that puts a (possibly fractional) source line at the top. */
    private offsetForLine(line: number): number {
        if (this.views.length === 0) {
            return 0;
        }
        if (line <= this.views[0].startLine) {
            return 0;
        }

        for (let index = 0; index < this.views.length; index++) {
            const view = this.views[index];
            const height = view.element.offsetHeight;
            if (line <= view.endLine) {
                const span = Math.max(1, view.endLine - view.startLine + 1);
                const progress = Math.min(1, Math.max(0, (line - view.startLine) / span));
                return this.topOf(view) + progress * height;
            }

            const following = this.views[index + 1];
            if (following && line < following.startLine) {
                // Whitespace between two cells: glide across the gap.
                const gap = Math.max(1, following.startLine - view.endLine);
                const progress = Math.min(1, Math.max(0, (line - view.endLine) / gap));
                const from = this.topOf(view) + height;
                const to = this.topOf(following);
                return from + progress * (to - from);
            }
        }

        return this.scrollEl.scrollHeight;
    }

    /** Inverse of offsetForLine: the source line showing at the top of the preview. */
    private lineForOffset(offset: number): number {
        if (this.views.length === 0) {
            return 0;
        }

        for (let index = 0; index < this.views.length; index++) {
            const view = this.views[index];
            const top = this.topOf(view);
            const height = view.element.offsetHeight;
            if (offset < top) {
                const previous = this.views[index - 1];
                if (!previous) {
                    return view.startLine;
                }
                const from = this.topOf(previous) + previous.element.offsetHeight;
                const progress = top > from ? Math.min(1, Math.max(0, (offset - from) / (top - from))) : 1;
                return previous.endLine + progress * Math.max(1, view.startLine - previous.endLine);
            }
            if (offset < top + height) {
                const span = Math.max(1, view.endLine - view.startLine + 1);
                const progress = height > 0 ? (offset - top) / height : 0;
                return view.startLine + progress * span;
            }
        }

        return this.views[this.views.length - 1].endLine;
    }

    private applyScrollToLine(line: number): void {
        const target = this.offsetForLine(line);
        if (Math.abs(target - this.scrollEl.scrollTop) < 1) {
            return;
        }
        this.quietUntil = Date.now() + SYNC_QUIET_MS;
        this.scrollEl.scrollTop = target;
    }

    private onPreviewScroll(): void {
        if (!this.scrollSync || Date.now() < this.quietUntil) {
            return;
        }
        window.clearTimeout(this.revealTimer);
        this.revealTimer = window.setTimeout(() => {
            this.post({ type: 'revealLine', line: this.lineForOffset(this.scrollEl.scrollTop) });
        }, REVEAL_DEBOUNCE_MS);
    }

    private captureAnchor(): { key: string; delta: number } | undefined {
        const containerTop = this.scrollEl.getBoundingClientRect().top;
        for (const view of this.views) {
            const rect = view.element.getBoundingClientRect();
            if (rect.bottom > containerTop + 1) {
                return { key: view.stableKey, delta: rect.top - containerTop };
            }
        }
        return undefined;
    }

    private restoreAnchor(anchor: { key: string; delta: number } | undefined): void {
        if (!anchor) {
            return;
        }
        const view = this.views.find(candidate => candidate.stableKey === anchor.key);
        if (!view) {
            return;
        }
        const containerTop = this.scrollEl.getBoundingClientRect().top;
        const correction = (view.element.getBoundingClientRect().top - containerTop) - anchor.delta;
        if (Math.abs(correction) > 0.5) {
            this.quietUntil = Date.now() + SYNC_QUIET_MS;
            this.scrollEl.scrollTop += correction;
        }
    }

    private markActiveLine(line: number): void {
        for (const view of this.views) {
            view.setActive(line >= view.startLine && line <= view.endLine);
        }
    }
}

const appRoot = document.getElementById('app');
if (appRoot) {
    new PreviewApp(appRoot).start();
}
