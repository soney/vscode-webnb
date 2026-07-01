/**
 * Renders one notebook: fetches its source from disk, parses it with the shared
 * parser, and lays out cells. Handles live disk reloads and virtual-filesystem
 * change re-runs.
 */
import { fetchNotebookSource } from './api';
import { parseNotebook, type CellModel } from './notebookModel';
import { CellView } from './cell';
import { ScratchStore } from './scratch';
import type { VirtualFs } from './vfs';
import type { NotebookSummary } from './types';

export interface NotebookViewDeps {
    workspaceId: string;
    vfs: VirtualFs;
}

/** Where the viewport was anchored before a reload, so we can restore it after. */
interface ScrollAnchor {
    /** Stable key of the cell crossing the top of the viewport. */
    key: string;
    /** Pixels from the scroll container's top edge to that cell's top edge. */
    delta: number;
}

// After a reload, cells re-execute and images load asynchronously, so the page
// keeps reflowing for a bit. Keep re-pinning the anchor cell over this window.
const ANCHOR_SETTLE_MS = 1500;

export class NotebookView {
    readonly element: HTMLElement;
    private readonly banner: HTMLElement;
    private readonly cellsHost: HTMLElement;
    private readonly scratch: ScratchStore;
    private cells: CellView[] = [];
    private cancelScrollRestore?: () => void;

    constructor(private readonly summary: NotebookSummary, private readonly deps: NotebookViewDeps) {
        this.scratch = new ScratchStore(deps.workspaceId, summary.path);

        this.element = document.createElement('div');
        this.element.className = 'notebook';

        this.banner = document.createElement('div');
        this.banner.className = 'notebook-banner';
        this.banner.hidden = true;

        this.cellsHost = document.createElement('div');
        this.cellsHost.className = 'notebook-cells';

        this.element.append(this.banner, this.cellsHost);
    }

    get path(): string {
        return this.summary.path;
    }

    get notebookDir(): string {
        return this.summary.dir;
    }

    async load(): Promise<void> {
        await this.render({ autorun: true });
    }

    async reloadFromDisk(): Promise<void> {
        const anchor = this.captureScrollAnchor();
        const editedBefore = this.scratch.editedCellKeys().length;
        await this.render({ autorun: true, restoreAnchor: anchor });
        if (editedBefore > 0) {
            this.showBanner(
                `This notebook changed on disk. ${editedBefore} cell(s) still show your browser edits.`,
                true
            );
        }
    }

    private async render(options: { autorun: boolean; restoreAnchor?: ScrollAnchor | null }): Promise<void> {
        this.cancelActiveScrollRestore();
        this.disposeCells();
        this.hideBanner();

        let models: CellModel[];
        try {
            const source = await fetchNotebookSource(this.summary.path);
            models = parseNotebook(source);
        } catch (error) {
            this.cellsHost.innerHTML = '';
            const err = document.createElement('pre');
            err.className = 'notebook-error';
            err.textContent = `Could not load notebook:\n${(error as Error).message}`;
            this.cellsHost.append(err);
            return;
        }

        const fragment = document.createDocumentFragment();
        this.cells = models.map(model => {
            const view = new CellView(model, {
                notebookPath: this.summary.path,
                notebookDir: this.summary.dir,
                vfs: this.deps.vfs,
                scratch: this.scratch,
                onEditedChange: () => this.onEditedChange()
            });
            fragment.append(view.element);
            return view;
        });

        this.cellsHost.innerHTML = '';
        this.cellsHost.append(fragment);

        if (options.restoreAnchor) {
            this.beginScrollRestore(options.restoreAnchor);
        }

        if (options.autorun) {
            // Defer so the editors/hosts are attached before cells execute.
            // Capture this render's cells so a concurrent reload can't make us
            // autorun a newer set twice.
            const cellsForThisRender = this.cells;
            requestAnimationFrame(() => {
                if (this.cells !== cellsForThisRender) { return; }
                for (const cell of cellsForThisRender) {
                    cell.autorunIfNeeded();
                }
            });
        }
    }

    /** Re-run cells that read the (virtual) filesystem after an overlay change. */
    onVfsChange(): void {
        for (const cell of this.cells) {
            if (cell.dependsOnFiles()) {
                void cell.run();
            }
        }
    }

    /** Reload images in markup cells when a workspace asset changes on disk. */
    onAssetChange(): void {
        for (const cell of this.cells) {
            cell.refreshMarkup();
        }
    }

    hasScratchEdits(): boolean {
        return this.scratch.editedCellKeys().length > 0;
    }

    async resetAllCells(): Promise<void> {
        const anchor = this.captureScrollAnchor();
        this.scratch.clearAllCode();
        await this.render({ autorun: true, restoreAnchor: anchor });
    }

    // ---- scroll anchoring --------------------------------------------------

    /** Nearest scrollable ancestor — the pane that actually holds scroll. */
    private scrollParent(): HTMLElement | null {
        let el = this.element.parentElement;
        while (el) {
            const overflowY = getComputedStyle(el).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    /** Record the cell at the top of the viewport so a reload can restore it. */
    private captureScrollAnchor(): ScrollAnchor | null {
        const container = this.scrollParent();
        if (!container || this.cells.length === 0) { return null; }
        const containerTop = container.getBoundingClientRect().top;
        for (const cell of this.cells) {
            const rect = cell.element.getBoundingClientRect();
            // First cell still extending below the viewport's top edge.
            if (rect.bottom > containerTop + 1) {
                return { key: cell.key, delta: rect.top - containerTop };
            }
        }
        // Scrolled past everything (e.g. at the very bottom) — pin the last cell.
        const last = this.cells[this.cells.length - 1];
        return { key: last.key, delta: last.element.getBoundingClientRect().top - containerTop };
    }

    /**
     * Re-pin the anchored cell after a rebuild, and keep re-pinning while the
     * page reflows (outputs executing, images loading, banner appearing). Stops
     * once layout settles, the user takes over scrolling, or the window elapses.
     */
    private beginScrollRestore(anchor: ScrollAnchor): void {
        this.cancelActiveScrollRestore();
        const container = this.scrollParent();
        if (!container) { return; }

        const apply = (): boolean => {
            const cell = this.cells.find(c => c.key === anchor.key);
            if (!cell) { return false; }
            const containerTop = container.getBoundingClientRect().top;
            const correction = (cell.element.getBoundingClientRect().top - containerTop) - anchor.delta;
            // Setting scrollTop fires no input events, so this won't self-cancel.
            if (Math.abs(correction) > 0.5) { container.scrollTop += correction; }
            return true;
        };

        // The anchored cell may have been deleted on disk — then there's nothing
        // to pin and no point watching for reflow.
        if (!apply()) { return; }

        const observer = new ResizeObserver(() => { apply(); });
        observer.observe(this.element);

        const stop = () => {
            observer.disconnect();
            window.removeEventListener('wheel', onUserScroll);
            window.removeEventListener('touchstart', onUserScroll);
            window.removeEventListener('keydown', onUserScroll);
            clearTimeout(timer);
            if (this.cancelScrollRestore === stop) { this.cancelScrollRestore = undefined; }
        };
        // Yield the moment the user starts scrolling themselves.
        const onUserScroll = () => stop();
        window.addEventListener('wheel', onUserScroll, { passive: true });
        window.addEventListener('touchstart', onUserScroll, { passive: true });
        window.addEventListener('keydown', onUserScroll);
        const timer = setTimeout(stop, ANCHOR_SETTLE_MS);

        this.cancelScrollRestore = stop;
    }

    private cancelActiveScrollRestore(): void {
        this.cancelScrollRestore?.();
        this.cancelScrollRestore = undefined;
    }

    private onEditedChange(): void {
        // Reserved hook (header badge updates could be wired here).
    }

    private showBanner(message: string, withReset: boolean): void {
        this.banner.innerHTML = '';
        const text = document.createElement('span');
        text.textContent = message;
        this.banner.append(text);
        if (withReset) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'banner-reset';
            button.textContent = 'Reset all cell edits';
            button.addEventListener('click', () => void this.resetAllCells());
            this.banner.append(button);
        }
        this.banner.hidden = false;
    }

    private hideBanner(): void {
        this.banner.hidden = true;
        this.banner.innerHTML = '';
    }

    private disposeCells(): void {
        for (const cell of this.cells) {
            cell.dispose();
        }
        this.cells = [];
    }

    dispose(): void {
        this.cancelActiveScrollRestore();
        this.disposeCells();
    }
}
