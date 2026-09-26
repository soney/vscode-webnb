/**
 * App shell: notebook sidebar, header actions, the active notebook view, the
 * virtual-files panel, and the live-reload wiring.
 */
import './styles.css';
// The renderer injects this into its shadow roots; markup cells render their
// code fences out in the page, so the light DOM needs the palette too.
import '../../src/client/syntaxHighlight.css';
import { bumpAssetVersion, fetchNotebookList } from './api';
import { NotebookView } from './notebook';
import { VirtualFs } from './vfs';
import { VFilesPanel } from './vfilesPanel';
import { getChoice, initTheme, onThemeChange, setChoice, type ThemeChoice } from './theme';
import type { FsChangeEvent, NotebookSummary } from './types';

initTheme();

interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    notebooks: NotebookSummary[];
}

function emptyNode(name: string): TreeNode {
    return { name, children: new Map(), notebooks: [] };
}

const SOLUTIONS_STORAGE_KEY = 'webnb-preview-solutions';

/**
 * `?solutions` (or `?solutions=1`) opens every notebook with each runnable
 * cell's `+solution` in place of its source, so the whole notebook can be
 * checked the way a learner who solved it would see it. `verify-notebooks
 * --solutions` drives the corpus through this. `?solutions=0` is off.
 */
function readSolutionsMode(): boolean {
    const value = new URLSearchParams(location.search).get('solutions');
    return value !== null && value !== '0' && value.toLowerCase() !== 'false';
}

/** Reveal buttons are on unless explicitly toggled off (mirrors the
 * extension's `webnb.allowRevealingSolutions` default). localStorage throws
 * in some privacy modes; the default applies then. */
function readStoredSolutions(): boolean {
    try {
        return localStorage.getItem(SOLUTIONS_STORAGE_KEY) !== '0';
    } catch {
        return true;
    }
}

class App {
    private readonly root: HTMLElement;
    private vfs!: VirtualFs;
    private vfilesPanel!: VFilesPanel;
    private workspaceId = 'default';
    private notebooks: NotebookSummary[] = [];
    private currentView?: NotebookView;
    private currentPath?: string;
    /** Mirrors VS Code's `webnb.allowRevealingSolutions` setting; on by default. */
    private showSolutions = readStoredSolutions();
    /** Cells start from their `+solution` (see readSolutionsMode). */
    private readonly solutionsMode = readSolutionsMode();

    private treeEl!: HTMLElement;
    private crumbsEl!: HTMLElement;
    private paneEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private resetCellsButton!: HTMLButtonElement;

    constructor(root: HTMLElement) {
        this.root = root;
    }

    async start(): Promise<void> {
        this.buildLayout();
        this.wireLiveReload();

        let workspace = '';
        try {
            const list = await fetchNotebookList();
            workspace = list.workspace;
            this.notebooks = list.notebooks;
        } catch (error) {
            this.paneEl.innerHTML = '';
            const err = document.createElement('pre');
            err.className = 'notebook-error';
            err.textContent =
                `Could not reach the dev server.\n${(error as Error).message}\n\n` +
                'Is the workspace configured? Set WEBNB_WORKSPACE or preview/webnb.config.json.';
            this.paneEl.append(err);
            return;
        }

        this.workspaceId = workspace || 'default';
        this.vfs = new VirtualFs(this.workspaceId);
        this.vfilesPanel = new VFilesPanel(this.vfs);
        document.body.append(this.vfilesPanel.element);
        this.vfs.onChange(() => this.currentView?.onVfsChange());

        this.setStatus(workspace);

        const fromHash = decodeURIComponent(location.hash.replace(/^#/, ''));
        const initial = this.notebooks.find(nb => nb.path === fromHash) ?? this.notebooks[0];
        if (initial) {
            this.currentPath = initial.path; // so the tree expands to reveal it
        }
        this.renderTree(this.notebooks);

        if (initial) {
            await this.openNotebook(initial);
        } else {
            this.paneEl.innerHTML = '<div class="empty-pane">No .webnb notebooks found in the workspace.</div>';
        }
    }

    private buildLayout(): void {
        this.root.innerHTML = `
            <div class="app">
                <aside class="sidebar">
                    <div class="sidebar-header">Web Notebook Preview</div>
                    <input class="sidebar-search" type="search" placeholder="Filter notebooks…" />
                    <div class="notebook-tree"></div>
                    <div class="sidebar-footer"><span class="status"></span></div>
                </aside>
                <main class="main">
                    <header class="main-header">
                        <div class="crumbs"></div>
                        <div class="header-actions">
                            <span class="mode-chip" hidden title="Opened with ?solutions: runnable cells show their +solution instead of their source. Drop the query parameter to leave this mode.">Solutions mode</span>
                            <div class="theme-picker" role="group" aria-label="Theme">
                                <button type="button" data-choice="auto" title="Follow the system theme" aria-label="Auto theme">◐</button>
                                <button type="button" data-choice="light" title="Always light" aria-label="Light theme">☀</button>
                                <button type="button" data-choice="dark" title="Always dark" aria-label="Dark theme">☾</button>
                            </div>
                            <button type="button" class="btn-solutions" title="Toggle the reader-facing reveal buttons (the webnb.allowRevealingSolutions setting in VS Code)">Solutions: shown</button>
                            <button type="button" class="btn-vfiles">Virtual Files</button>
                            <button type="button" class="btn-reset-cells" hidden>Reset cell edits</button>
                        </div>
                    </header>
                    <section class="notebook-pane"></section>
                </main>
            </div>
        `;

        this.treeEl = this.root.querySelector('.notebook-tree') as HTMLElement;
        this.crumbsEl = this.root.querySelector('.crumbs') as HTMLElement;
        this.paneEl = this.root.querySelector('.notebook-pane') as HTMLElement;
        this.statusEl = this.root.querySelector('.status') as HTMLElement;
        this.resetCellsButton = this.root.querySelector('.btn-reset-cells') as HTMLButtonElement;
        (this.root.querySelector('.mode-chip') as HTMLElement).hidden = !this.solutionsMode;

        const search = this.root.querySelector('.sidebar-search') as HTMLInputElement;
        search.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            const filtered = query
                ? this.notebooks.filter(nb => nb.path.toLowerCase().includes(query) || nb.name.toLowerCase().includes(query))
                : this.notebooks;
            this.renderTree(filtered, query.length > 0);
        });

        const themeButtons = Array.from(
            this.root.querySelectorAll<HTMLButtonElement>('.theme-picker button')
        );
        // `aria-pressed` marks the choice, not the resolved theme: with `auto`
        // selected it stays on `auto` whichever way the OS happens to be set.
        const paintThemePicker = () => {
            const choice = getChoice();
            for (const button of themeButtons) {
                button.setAttribute('aria-pressed', String(button.dataset.choice === choice));
            }
        };
        paintThemePicker();
        onThemeChange(paintThemePicker);
        for (const button of themeButtons) {
            button.addEventListener('click', () => setChoice(button.dataset.choice as ThemeChoice));
        }

        const solutionsButton = this.root.querySelector('.btn-solutions') as HTMLButtonElement;
        const paintSolutionsButton = () => {
            solutionsButton.textContent = `Solutions: ${this.showSolutions ? 'shown' : 'hidden'}`;
            solutionsButton.setAttribute('aria-pressed', String(this.showSolutions));
        };
        paintSolutionsButton();
        solutionsButton.addEventListener('click', () => {
            this.showSolutions = !this.showSolutions;
            try {
                localStorage.setItem(SOLUTIONS_STORAGE_KEY, this.showSolutions ? '1' : '0');
            } catch {
                // Ignore: the choice still applies for this session.
            }
            paintSolutionsButton();
            this.currentView?.onSolutionsChange();
        });

        (this.root.querySelector('.btn-vfiles') as HTMLButtonElement).addEventListener('click', () => {
            this.vfilesPanel?.toggle();
        });

        this.resetCellsButton.addEventListener('click', () => {
            void this.currentView?.resetAllCells();
        });
    }

    private setStatus(workspace: string): void {
        const live = !!import.meta.hot;
        this.statusEl.innerHTML =
            `<span class="status-dot ${live ? 'live' : 'offline'}"></span>` +
            `<span class="status-text">${live ? 'live' : 'offline'} · ${workspace}</span>`;
    }

    // ---- tree --------------------------------------------------------------

    private renderTree(notebooks: NotebookSummary[], expandAll = false): void {
        const tree = emptyNode('');
        for (const nb of notebooks) {
            const segments = nb.dir ? nb.dir.split('/') : [];
            let node = tree;
            for (const segment of segments) {
                if (!node.children.has(segment)) {
                    node.children.set(segment, emptyNode(segment));
                }
                node = node.children.get(segment)!;
            }
            node.notebooks.push(nb);
        }
        this.treeEl.innerHTML = '';
        this.treeEl.append(this.renderTreeNode(tree, expandAll, true));
    }

    private renderTreeNode(node: TreeNode, expandAll: boolean, isRoot: boolean): HTMLElement {
        const container = document.createElement('div');
        container.className = isRoot ? 'tree-root' : 'tree-group';

        const childNames = Array.from(node.children.keys()).sort((a, b) => a.localeCompare(b));
        for (const name of childNames) {
            const child = node.children.get(name)!;
            const details = document.createElement('details');
            details.className = 'tree-folder';
            details.open = expandAll || isRoot || this.nodeContainsActive(child);
            const summary = document.createElement('summary');
            summary.textContent = name;
            details.append(summary, this.renderTreeNode(child, expandAll, false));
            container.append(details);
        }

        const sortedNotebooks = node.notebooks.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const nb of sortedNotebooks) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'tree-notebook';
            item.dataset.path = nb.path;
            item.textContent = nb.name;
            if (nb.path === this.currentPath) {
                item.classList.add('active');
            }
            item.addEventListener('click', () => void this.openNotebook(nb));
            container.append(item);
        }

        return container;
    }

    private nodeContainsActive(node: TreeNode): boolean {
        if (!this.currentPath) { return false; }
        if (node.notebooks.some(nb => nb.path === this.currentPath)) { return true; }
        for (const child of node.children.values()) {
            if (this.nodeContainsActive(child)) { return true; }
        }
        return false;
    }

    private highlightActive(): void {
        this.treeEl.querySelectorAll('.tree-notebook').forEach(el => {
            el.classList.toggle('active', (el as HTMLElement).dataset.path === this.currentPath);
        });
    }

    // ---- notebook ----------------------------------------------------------

    private async openNotebook(summary: NotebookSummary): Promise<void> {
        this.currentView?.dispose();
        this.currentPath = summary.path;
        location.hash = encodeURIComponent(summary.path);
        this.highlightActive();

        this.crumbsEl.innerHTML = '';
        const dirSpan = document.createElement('span');
        dirSpan.className = 'crumb-dir';
        dirSpan.textContent = summary.dir ? `${summary.dir}/` : '';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'crumb-name';
        nameSpan.textContent = summary.name;
        this.crumbsEl.append(dirSpan, nameSpan);

        this.resetCellsButton.hidden = false;
        this.vfilesPanel.setNotebookContext(summary.dir);

        const view = new NotebookView(summary, {
            workspaceId: this.workspaceId,
            vfs: this.vfs,
            showSolutions: () => this.showSolutions,
            solutionsMode: this.solutionsMode
        });
        this.currentView = view;
        this.paneEl.innerHTML = '';
        this.paneEl.append(view.element);
        this.paneEl.scrollTop = 0;
        await view.load();
    }

    // ---- live reload -------------------------------------------------------

    private wireLiveReload(): void {
        if (!import.meta.hot) { return; }
        import.meta.hot.on('webnb:fs-change', (data: FsChangeEvent) => {
            // Notebook added/removed → refresh the list.
            if (data.isNotebook && (data.event === 'add' || data.event === 'unlink')) {
                void this.refreshNotebookList();
            }

            if (!this.currentView || !this.currentPath) { return; }

            if (data.isNotebook) {
                if (data.path === this.currentPath) {
                    void this.currentView.reloadFromDisk();
                }
                return;
            }

            // Non-notebook asset changed. If it lives under the current notebook's
            // directory, reload its images / re-run file-dependent cells.
            const dir = this.currentView.notebookDir;
            if (!dir || data.path.startsWith(dir + '/')) {
                bumpAssetVersion();
                this.currentView.onAssetChange();
                this.currentView.onVfsChange();
            }
        });
    }

    private async refreshNotebookList(): Promise<void> {
        try {
            const list = await fetchNotebookList();
            this.notebooks = list.notebooks;
            const search = this.root.querySelector('.sidebar-search') as HTMLInputElement;
            const query = search.value.trim().toLowerCase();
            const filtered = query
                ? this.notebooks.filter(nb => nb.path.toLowerCase().includes(query) || nb.name.toLowerCase().includes(query))
                : this.notebooks;
            this.renderTree(filtered, query.length > 0);
        } catch {
            // ignore transient list errors
        }
    }
}

const appRoot = document.getElementById('app');
if (appRoot) {
    void new App(appRoot).start();
}
