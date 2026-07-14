/**
 * A single notebook cell in the preview.
 *  - Markup cells render as markdown (read-only), matching VS Code.
 *  - Code cells get an editor, a Run button, and a live output rendered by the
 *    extension's renderer. Browser edits go to the scratch store (localStorage),
 *    never to disk.
 */
import { createEditor, type CellEditor } from './editor';
import { CellOutputHost, type PreviewRendererContext } from './rendererHost';
import { renderMarkdownBlock, resolveRelativeAssets } from './markdown';
import { buildOutputValue, dependsOnFiles, shouldAutorun } from './kernel';
import { cellKeyFor, type CellModel } from './notebookModel';
import type { Addon, RendererMessage } from './types';
import type { VirtualFs } from './vfs';
import type { ScratchStore } from './scratch';

export interface CellContext {
    notebookPath: string;
    notebookDir: string;
    vfs: VirtualFs;
    scratch: ScratchStore;
    onEditedChange: () => void;
}

function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

const LANGUAGE_LABELS: Record<string, string> = {
    javascript: 'JavaScript',
    js: 'JavaScript',
    node: 'Node',
    html: 'HTML',
    css: 'CSS',
    jsx: 'JSX',
    react: 'React',
    javascriptreact: 'React',
    mcq: 'Multiple Choice',
    external: 'File Checklist',
    checklist: 'File Checklist'
};

export class CellView {
    element!: HTMLElement;
    private editor?: CellEditor;
    private host?: CellOutputHost;
    private outputHostEl?: HTMLElement;
    private readonly cellKey: string;
    private readonly cellUri: string;
    private runToken = 0;
    private editedBadge?: HTMLElement;
    private resetButton?: HTMLButtonElement;
    private hasRun = false;

    constructor(private readonly model: CellModel, private readonly ctx: CellContext) {
        this.cellKey = cellKeyFor(model);
        this.cellUri = `webnb-cell://${ctx.notebookPath}#${this.cellKey}`;
        this.element = model.kind === 'code' ? this.buildCodeCell() : this.buildMarkupCell();
    }

    get isCode(): boolean {
        return this.model.kind === 'code';
    }

    /** Stable identity across disk reloads — used to re-anchor scroll position. */
    get key(): string {
        return this.cellKey;
    }

    private get addons(): Addon[] {
        return this.model.metadata.addons ?? [];
    }

    // ---- markup ------------------------------------------------------------

    private buildMarkupCell(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cell cell-markup';
        el.innerHTML = renderMarkdownBlock(this.model.value);
        resolveRelativeAssets(el, this.ctx.notebookDir);
        return el;
    }

    /** Re-render markup (used to reload images when an asset changes on disk). */
    refreshMarkup(): void {
        if (this.model.kind !== 'markup') { return; }
        this.element.innerHTML = renderMarkdownBlock(this.model.value);
        resolveRelativeAssets(this.element, this.ctx.notebookDir);
    }

    // ---- code --------------------------------------------------------------

    private buildCodeCell(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cell cell-code';
        el.dataset.language = this.model.languageId;
        this.element = el; // set before refreshEditedState() reads it below

        const toolbar = document.createElement('div');
        toolbar.className = 'cell-toolbar';

        const runButton = document.createElement('button');
        runButton.className = 'cell-run';
        runButton.type = 'button';
        runButton.innerHTML = '<span class="cell-run-icon">▶</span> Run';
        runButton.title = 'Run cell (⌘/Ctrl+Enter)';
        runButton.addEventListener('click', () => void this.run());

        const langChip = document.createElement('span');
        langChip.className = 'cell-lang';
        langChip.textContent = LANGUAGE_LABELS[this.model.languageId] || this.model.languageId;

        const spacer = document.createElement('span');
        spacer.className = 'cell-toolbar-spacer';

        this.editedBadge = document.createElement('span');
        this.editedBadge.className = 'cell-edited-badge';
        this.editedBadge.textContent = 'edited in browser';
        this.editedBadge.hidden = true;

        this.resetButton = document.createElement('button');
        this.resetButton.className = 'cell-reset';
        this.resetButton.type = 'button';
        this.resetButton.textContent = 'Reset to disk';
        this.resetButton.hidden = true;
        this.resetButton.addEventListener('click', () => this.resetToDisk());

        toolbar.append(runButton, langChip, spacer, this.editedBadge, this.resetButton);

        const solutionAddon = this.addons.find(addon => normalizeAddonType(addon.type) === 'solution');
        if (solutionAddon) {
            const solutionToggle = document.createElement('button');
            solutionToggle.className = 'cell-solution-toggle';
            solutionToggle.type = 'button';
            solutionToggle.textContent = 'Show solution';
            toolbar.insertBefore(solutionToggle, this.editedBadge);

            const solutionBlock = document.createElement('pre');
            solutionBlock.className = 'cell-solution';
            solutionBlock.hidden = true;
            solutionBlock.textContent = solutionAddon.content;

            solutionToggle.addEventListener('click', () => {
                solutionBlock.hidden = !solutionBlock.hidden;
                solutionToggle.textContent = solutionBlock.hidden ? 'Show solution' : 'Hide solution';
            });
            el.append(toolbar, solutionBlock);
        } else {
            el.append(toolbar);
        }

        // Editor
        const editorHost = document.createElement('div');
        editorHost.className = 'cell-editor';
        const initialDoc = this.ctx.scratch.getCode(this.cellKey) ?? this.model.value;
        this.editor = createEditor({
            doc: initialDoc,
            language: this.model.languageId,
            onChange: value => this.onEditorChange(value),
            onRun: () => void this.run()
        });
        editorHost.append(this.editor.dom);
        el.append(editorHost);

        // Output
        this.outputHostEl = document.createElement('div');
        this.outputHostEl.className = 'cell-output';
        el.append(this.outputHostEl);
        this.host = new CellOutputHost(this.outputHostEl, this.makeContext());

        this.refreshEditedState();
        return el;
    }

    private makeContext(): PreviewRendererContext {
        return {
            postMessage: (message: RendererMessage) => {
                if (message.type === 'webnb.refreshCell') {
                    void this.run();
                } else if (message.type === 'webnb.upsertCellAddon') {
                    // Persist MCQ selection (matches VS Code: metadata update does
                    // NOT re-execute the cell, it just remembers the choice).
                    if (normalizeAddonType(message.addonType) === 'selection') {
                        this.ctx.scratch.setSelection(this.cellKey, message.content);
                    }
                } else if (message.type === 'webnb.openWorkspaceFile') {
                    // In VS Code this opens the real file beside the notebook.
                    // The browser preview has no workspace editor, so ignore it.
                }
            }
        };
    }

    private onEditorChange(value: string): void {
        if (value === this.model.value) {
            this.ctx.scratch.clearCode(this.cellKey);
        } else {
            this.ctx.scratch.setCode(this.cellKey, value);
        }
        this.refreshEditedState();
        this.ctx.onEditedChange();
    }

    private refreshEditedState(): void {
        const edited = this.ctx.scratch.hasCode(this.cellKey);
        if (this.editedBadge) { this.editedBadge.hidden = !edited; }
        if (this.resetButton) { this.resetButton.hidden = !edited; }
        this.element.classList.toggle('is-edited', edited);
    }

    private resetToDisk(): void {
        this.ctx.scratch.clearCode(this.cellKey);
        this.editor?.setValue(this.model.value);
        this.refreshEditedState();
        this.ctx.onEditedChange();
        if (this.hasRun) { void this.run(); }
    }

    // ---- execution ---------------------------------------------------------

    dependsOnFiles(): boolean {
        return this.isCode && dependsOnFiles(this.model.languageId, this.currentSource(), this.addons);
    }

    private currentSource(): string {
        return this.editor ? this.editor.getValue() : this.model.value;
    }

    autorunIfNeeded(): void {
        if (shouldAutorun(this.model)) {
            void this.run();
        }
    }

    async run(): Promise<void> {
        if (!this.isCode || !this.host) { return; }
        const token = ++this.runToken;
        this.element.classList.add('is-running');

        const addons: Addon[] = [...this.addons];
        if (this.model.languageId === 'mcq') {
            const selection = this.ctx.scratch.getSelection(this.cellKey);
            if (selection !== undefined) {
                addons.push({ type: 'selection', content: selection });
            }
        }

        try {
            const value = await buildOutputValue({
                notebookPath: this.ctx.notebookPath,
                cellUri: this.cellUri,
                source: this.currentSource(),
                languageId: this.model.languageId,
                addons,
                vfs: this.ctx.vfs
            });
            if (token !== this.runToken) { return; } // superseded by a newer run
            this.host.render(value);
            this.hasRun = true;
        } finally {
            if (token === this.runToken) {
                this.element.classList.remove('is-running');
            }
        }
    }

    dispose(): void {
        this.editor?.destroy();
        this.host?.dispose();
    }
}
