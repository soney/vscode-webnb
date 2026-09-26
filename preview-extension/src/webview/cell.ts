/**
 * A single cell in the source preview.
 *
 *  - Markup cells render as Markdown.
 *  - Code cells show their source read-only, plus a live output rendered by the
 *    notebook's renderer. The .webnb text editor beside the preview is where
 *    you edit; nothing typed in here can reach the file.
 */
import { CellOutputHost } from './rendererHost';
import {
    annotateBlockLines,
    renderMarkdownBlock,
    resolveRelativeAssets,
    SOURCE_LINE_OFFSET_ATTRIBUTE,
    type AssetResolver
} from './markdown';
import { escapeHtml, highlightToLines } from '@webnb/client/syntaxHighlight';
import {
    FILE_SNAPSHOT_ADDON_TYPES,
    isAutoWidgetLanguage,
    normalizeAddonType,
    runsOnOpen
} from '@webnb/shared/addons';
import type { WebNbRendererMessage, WorkspaceFileSnapshotEntry } from '@webnb/shared/protocol';
import type { Addon, PreviewCell } from '../shared/previewProtocol';

/** What a hovered walkthrough step points at in a workspace file. */
export interface WorkspaceLineTarget {
    path?: string;
    ranges?: { start: number; end: number }[];
    line?: number;
}

export interface CellDeps {
    assets: AssetResolver;
    /** Synthetic URI for a cell, stable across edits. */
    cellUri(model: PreviewCell): string;
    /** Ask the host for the workspace files this cell's checks reference. */
    requestSnapshot(language: string, source: string, addons: Addon[]): Promise<{
        addons: Addon[];
        files: Record<string, WorkspaceFileSnapshotEntry>;
    }>;
    /** Whether solutions may be revealed (mirrors webnb.allowRevealingSolutions). */
    reveal(): boolean;
    /** Remembered MCQ answer, kept in webview state and never written to the file. */
    getSelection(stableKey: string): string | undefined;
    setSelection(stableKey: string, content: string): void;
    /** Move the source editor to a line in the document. */
    jumpToLine(line: number): void;
    /** A link clicked in a markup cell, as written (another notebook, a `#section`, a file). */
    openLink(href: string): void;
    openWorkspaceFile(path: string, line?: number): void;
    highlightWorkspaceLines(target: WorkspaceLineTarget): void;
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
    checklist: 'File Checklist',
    walkthrough: 'Walkthrough'
};

const HIGHLIGHT_LANGUAGES: Record<string, string> = {
    javascript: 'javascript',
    js: 'javascript',
    node: 'javascript',
    javascriptreact: 'javascript',
    react: 'javascript',
    jsx: 'javascript',
    html: 'xml',
    css: 'css',
    markdown: 'markdown',
    mcq: 'markdown',
    external: 'yaml',
    checklist: 'yaml',
    walkthrough: 'yaml'
};

/**
 * Cells whose source the notebook collapses on open: the self-rendering
 * widgets, and anything the author flagged `hidecode`. The preview still offers
 * the toggle -- this is an authoring view, and the author is the one person who
 * does need to see the code behind a widget.
 */
function startsCollapsed(model: PreviewCell): boolean {
    return model.hidecode === true || isAutoWidgetLanguage(model.languageId);
}

export class CellView {
    readonly element: HTMLElement;
    private model: PreviewCell;
    private readonly deps: CellDeps;
    private host?: CellOutputHost;
    private outputEl?: HTMLElement;
    private gotoButton?: HTMLButtonElement;
    private runToken = 0;
    private hasRun = false;

    constructor(model: PreviewCell, deps: CellDeps) {
        this.model = model;
        this.deps = deps;
        this.element = document.createElement('div');
        this.element.className = model.kind === 'code' ? 'wnb-cell wnb-cell-code' : 'wnb-cell wnb-cell-markup';
        this.element.addEventListener('click', event => this.onClick(event));

        if (model.kind === 'code') {
            this.buildCodeCell();
        } else {
            this.buildMarkupCell();
        }
    }

    /** Identity used for reconciling: changes whenever the cell's content changes. */
    get key(): string {
        return this.model.contentKey;
    }

    /** Identity that survives edits: used for scroll anchoring and remembered answers. */
    get stableKey(): string {
        return this.model.stableKey;
    }

    get startLine(): number {
        return this.model.startLine;
    }

    get endLine(): number {
        return this.model.endLine;
    }

    get ran(): boolean {
        return this.hasRun;
    }

    /** Reuse this view for an identical cell that moved in the document. */
    adoptPosition(model: PreviewCell): void {
        this.model = model;
        this.updateGotoTitle();
    }

    private updateGotoTitle(): void {
        if (this.gotoButton) {
            this.gotoButton.title = `Reveal line ${this.model.startLine + 1} in the editor`;
        }
    }

    setActive(active: boolean): void {
        this.element.classList.toggle('is-active', active);
    }

    /**
     * Clicking the preview puts the editor's cursor on the matching source line.
     *
     * Three things must not trigger it: a live output (the reader is using the
     * widget, not navigating), a control (buttons and links do their own job),
     * and a click that ends a text selection (dragging to copy is not a jump).
     */
    private onClick(event: MouseEvent): void {
        const target = event.target as HTMLElement | null;
        if (!target || this.outputEl?.contains(target)) {
            return;
        }
        if (target.closest('button, a, input, select, textarea, [contenteditable]')) {
            return;
        }
        if (window.getSelection()?.toString()) {
            return;
        }

        // The most specific tagged ancestor: a source line or a rendered block,
        // falling back to the cell itself for anything that carries no tag.
        // Tags are offsets into the cell, so this is right even after lines
        // were added above a cell whose own text did not change.
        const anchor = target.closest<HTMLElement>(`[${SOURCE_LINE_OFFSET_ATTRIBUTE}]`);
        const offset = Number(anchor?.getAttribute(SOURCE_LINE_OFFSET_ATTRIBUTE));
        this.deps.jumpToLine(this.model.startLine + (anchor && Number.isFinite(offset) ? offset : 0));
    }

    // ---- markup ------------------------------------------------------------

    private buildMarkupCell(): void {
        this.element.innerHTML = renderMarkdownBlock(this.model.value);
        annotateBlockLines(this.element, this.model.value);
        resolveRelativeAssets(this.element, this.deps.assets);
        this.element.querySelectorAll<HTMLElement>('[data-webnb-link]').forEach(link => {
            const follow = (event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                this.deps.openLink(link.dataset.webnbLink!);
            };
            link.addEventListener('click', follow);
            link.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    follow(event);
                }
            });
        });
    }

    /** Re-resolve media URLs so changed images reload. */
    refreshAssets(): void {
        if (this.model.kind === 'markup') {
            this.buildMarkupCell();
        }
    }

    // ---- code --------------------------------------------------------------

    private buildCodeCell(): void {
        this.element.dataset.language = this.model.languageId;

        const toolbar = document.createElement('div');
        toolbar.className = 'wnb-cell-toolbar';

        const runButton = document.createElement('button');
        runButton.type = 'button';
        runButton.className = 'wnb-run';
        runButton.title = 'Run this cell';
        runButton.innerHTML = '<span class="wnb-run-icon">&#9654;</span><span>Run</span>';
        runButton.addEventListener('click', () => void this.run());

        const language = document.createElement('span');
        language.className = 'wnb-chip';
        language.textContent = LANGUAGE_LABELS[this.model.languageId] ?? this.model.languageId;

        toolbar.append(runButton, language);

        for (const badge of this.badges()) {
            const chip = document.createElement('span');
            chip.className = 'wnb-chip wnb-chip-muted';
            chip.textContent = badge;
            toolbar.append(chip);
        }

        const spacer = document.createElement('span');
        spacer.className = 'wnb-spacer';

        const sourceToggle = document.createElement('button');
        sourceToggle.type = 'button';
        sourceToggle.className = 'wnb-link-button';

        const gotoButton = document.createElement('button');
        gotoButton.type = 'button';
        gotoButton.className = 'wnb-link-button';
        gotoButton.textContent = 'Go to source';
        this.gotoButton = gotoButton;
        this.updateGotoTitle();
        gotoButton.addEventListener('click', () => this.deps.jumpToLine(this.model.startLine));

        toolbar.append(spacer, sourceToggle, gotoButton);

        const source = document.createElement('pre');
        source.className = 'wnb-cell-source';
        const code = document.createElement('code');
        const highlightLanguage = HIGHLIGHT_LANGUAGES[this.model.languageId.toLowerCase()];
        code.className = `hljs${highlightLanguage ? ` language-${highlightLanguage}` : ''}`;
        code.innerHTML = this.sourceHtml(highlightLanguage);
        source.append(code);

        let collapsed = startsCollapsed(this.model);
        const applyCollapsed = () => {
            source.hidden = collapsed;
            sourceToggle.textContent = collapsed ? 'Show source' : 'Hide source';
        };
        sourceToggle.addEventListener('click', () => {
            collapsed = !collapsed;
            applyCollapsed();
        });
        applyCollapsed();

        const output = document.createElement('div');
        output.className = 'wnb-cell-output';
        this.outputEl = output;
        this.host = new CellOutputHost(output, {
            postMessage: message => this.onRendererMessage(message)
        });

        this.element.append(toolbar, source, output);
    }

    /**
     * The cell's source, one tagged row per line, so clicking a line goes to
     * that line. The body starts one line after the opening fence, so body
     * line N sits N + 1 lines below the cell's start.
     */
    private sourceHtml(highlightLanguage: string | undefined): string {
        const lines = highlightToLines(this.model.value, highlightLanguage)
            ?? this.model.value.split('\n').map(escapeHtml);
        return lines
            .map((html, index) =>
                `<span class="wnb-source-line" ${SOURCE_LINE_OFFSET_ATTRIBUTE}="${index + 1}">${html}</span>`)
            .join('\n');
    }

    private badges(): string[] {
        const badges: string[] = [];
        if (this.model.id) {
            badges.push(`id=${this.model.id}`);
        }
        if (this.model.autorun) {
            badges.push('autorun');
        }
        if (this.model.runonstart) {
            badges.push('runonstart');
        }
        if (this.model.hidecode) {
            badges.push('hidecode');
        }
        for (const addon of this.model.addons) {
            badges.push(`+${normalizeAddonType(addon.type)}`);
        }
        return badges;
    }

    private onRendererMessage(message: WebNbRendererMessage): void {
        switch (message.type) {
            case 'webnb.refreshCell':
                void this.run();
                return;
            case 'webnb.upsertCellAddon':
                // The notebook writes this to cell metadata; the preview must not
                // touch the document, so remember it in webview state instead.
                if (normalizeAddonType(message.addonType) === 'selection') {
                    this.deps.setSelection(this.model.stableKey, message.content);
                }
                return;
            case 'webnb.resetCellSource':
                // "Reset code" rewrites the cell in the notebook. Here the source
                // is the file, so send the author to it instead of editing it.
                this.deps.jumpToLine(this.model.startLine);
                return;
            case 'webnb.openWorkspaceFile':
                this.deps.openWorkspaceFile(message.path, message.line);
                return;
            case 'webnb.highlightWorkspaceLines':
                this.deps.highlightWorkspaceLines({
                    path: message.path,
                    ranges: message.ranges,
                    line: message.line
                });
                return;
        }
    }

    // ---- execution ---------------------------------------------------------

    /** Cells that run without the reader pressing anything. */
    autorunIfNeeded(): void {
        if (this.model.kind === 'code' && runsOnOpen(this.model)) {
            void this.run();
        }
    }

    async run(): Promise<void> {
        if (this.model.kind !== 'code' || !this.host) {
            return;
        }

        const token = ++this.runToken;
        this.element.classList.add('is-running');
        this.hasRun = true;

        const addons: Addon[] = [...this.model.addons];
        if (this.model.languageId === 'mcq') {
            const selection = this.deps.getSelection(this.model.stableKey);
            if (selection !== undefined) {
                addons.push({ type: 'selection', content: selection });
            }
        }

        try {
            // The host snapshots whatever files the cell's checks name.
            const snapshot = await this.deps.requestSnapshot(this.model.languageId, this.model.value, addons);
            if (token !== this.runToken) {
                return; // superseded by a newer run
            }
            this.host.render({
                source: this.model.value,
                language: this.model.languageId,
                addons: snapshot.addons,
                files: snapshot.files,
                cellUri: this.deps.cellUri(this.model),
                checkedAt: Date.now(),
                reveal: this.deps.reveal(),
                height: this.model.height
            });
            this.element.classList.add('has-output');
        } catch (error) {
            console.error('[webnb-preview] cell run failed', error);
        } finally {
            if (token === this.runToken) {
                this.element.classList.remove('is-running');
            }
        }
    }

    /** Auto-widgets and file checks re-read the workspace, so refresh them on disk changes. */
    dependsOnWorkspace(): boolean {
        return this.model.kind === 'code'
            && (isAutoWidgetLanguage(this.model.languageId)
                || this.model.addons.some(addon => FILE_SNAPSHOT_ADDON_TYPES.has(normalizeAddonType(addon.type))));
    }

    /** Re-render an existing output, e.g. after the solutions setting changes. */
    rerunIfRan(): void {
        if (this.hasRun) {
            void this.run();
        }
    }

    dispose(): void {
        this.runToken++;
        this.host?.dispose();
        this.host = undefined;
    }
}
