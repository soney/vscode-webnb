/**
 * The webnb notebook kernel: owns the notebook controller, executes cells
 * (source + addons + workspace snapshots → one JSON output the renderer
 * draws), and routes renderer messages. Scheduling, highlighting, and
 * snapshotting live in their own modules:
 *  - autorunScheduler.ts   when autorun/widget cells execute
 *  - walkthroughHighlighter.ts  hover highlights + opening workspace files
 *  - workspaceSnapshots.ts  path resolution + file snapshots
 */
import * as vscode from 'vscode';
import {
    isRendererMessage,
    WEBNB_OUTPUT_MIME,
    type Addon
} from '../shared/protocol';
import {
    getDefaultCaptureAddons,
    isAutoWidgetLanguage,
    isExternalCheckLanguage,
    isWalkthroughLanguage,
    normalizeAddonType,
    upsertAddon
} from '../shared/addons';
import { cellLabel, errorExecution, logChannel, logExecution, rangesLabel, uriLabel, visibleNotebookLabels, warnExecution } from './log';
import { isRemoteNotebookAlias, notebookUrisMatch } from './notebookUris';
import { AutorunScheduler } from './autorunScheduler';
import { WalkthroughHighlighter } from './walkthroughHighlighter';
import { snapshotWorkspaceFiles } from './workspaceSnapshots';

const SUPPORTED_LANGUAGES = ['javascript', 'node', 'html', 'css', 'js', 'javascriptreact', 'react', 'jsx', 'mcq', 'external', 'checklist', 'walkthrough'];
const RENDERER_ID = 'practical-javascript-reading-notebook';
// VS Code's public API can mark this controller as preferred, but web notebooks
// still need the internal command to select it before programmatic autorun.
const SELECT_KERNEL_COMMAND = '_notebook.selectKernel';

function getCellAddons(cell: vscode.NotebookCell): Addon[] {
    const addons = cell.metadata?.addons;
    return Array.isArray(addons) ? addons : [];
}

/** Cells that render an interactive widget and should run on notebook open. */
function isAutoWidgetCell(cell: vscode.NotebookCell): boolean {
    return isAutoWidgetLanguage(cell.document.languageId);
}

/** Cells whose renderer re-runs them (checklist polling, walkthrough watch). */
function isAutoRefreshingCell(cell: vscode.NotebookCell): boolean {
    return isExternalCheckLanguage(cell.document.languageId)
        || isWalkthroughLanguage(cell.document.languageId);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(logChannel, new WebNotebookKernel(context.extension.id));
}

export function deactivate() { }

export class WebNotebookKernel implements vscode.Disposable {
    public readonly id = 'webnb-kernel';
    public readonly notebookType = 'web-notebook';
    public readonly label = 'Web Notebook';

    private readonly _controller: vscode.NotebookController;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _extensionId: string;
    private readonly _cellExecutionVersions = new Map<string, number>();
    private readonly _scheduler: AutorunScheduler;
    private readonly _highlighter = new WalkthroughHighlighter();

    private _ensureControllerAssociation(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== this.notebookType || isRemoteNotebookAlias(notebook.uri)) {
            return;
        }

        try {
            this._controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
        } catch {
            // Some hosts may reject affinity updates transiently.
            // Execution has a fallback path if association is unavailable.
        }
    }

    public constructor(extensionId: string) {
        this._extensionId = extensionId;
        this._controller = vscode.notebooks.createNotebookController(this.id, this.notebookType, this.label);
        this._controller.supportedLanguages = SUPPORTED_LANGUAGES;
        this._controller.description = 'Web Notebook';
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.executeHandler.bind(this);
        this._scheduler = new AutorunScheduler({
            notebookType: this.notebookType,
            ensureControllerAssociation: notebook => this._ensureControllerAssociation(notebook),
            isAutoWidgetCell,
            executeRanges: (notebook, ranges) => this._executeNotebookRanges(notebook, ranges)
        });
        const rendererMessaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);

        const initializeEditor = (editor: vscode.NotebookEditor) => {
            this._collapseWidgetCells(editor);
            this._scheduler.runForEditor(editor);
        };

        this._disposables.push(
            this._controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
                if (selected) {
                    this._scheduler.runForNotebook(notebook);
                }
            }),
            rendererMessaging.onDidReceiveMessage(({ editor, message }) => {
                if (editor.notebook.notebookType !== this.notebookType || !isRendererMessage(message)) {
                    return;
                }

                const cell = editor.notebook.getCells()
                    .find(candidate => candidate.document.uri.toString() === message.cellUri);
                if (!cell) {
                    return;
                }

                if (message.type === 'webnb.refreshCell') {
                    if (!isAutoRefreshingCell(cell)) {
                        return;
                    }
                    void this._executeNotebookRanges(editor.notebook, [
                        new vscode.NotebookRange(cell.index, cell.index + 1)
                    ]);
                    return;
                }

                if (message.type === 'webnb.openWorkspaceFile') {
                    void this._highlighter.open(cell, message.path, message.line);
                    return;
                }

                if (message.type === 'webnb.highlightWorkspaceLines') {
                    this._highlighter.highlight(cell, message.path, message.ranges, message.line);
                    return;
                }

                void this._upsertCellAddon(cell, message.addonType, message.content);
            }),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                this._scheduler.forgetNotebook(notebook.uri);
                for (const cell of notebook.getCells()) {
                    this._cellExecutionVersions.delete(cell.document.uri.toString());
                }
                // The renderer cannot send its own clear once the webview is gone.
                this._highlighter.clear();
            }),
            vscode.workspace.onDidOpenNotebookDocument(notebook => {
                this._ensureControllerAssociation(notebook);
                this._scheduler.runForNotebook(notebook);
                this._scheduler.scheduleSweep();
            }),
            vscode.workspace.onDidChangeNotebookDocument(event => {
                if (event.notebook.notebookType !== this.notebookType) {
                    return;
                }

                // Cells can appear after initial open events; retry autorun when the
                // notebook structure changes so autorun cells still execute.
                if (event.cellChanges.length === 0 && event.contentChanges.length === 0) {
                    return;
                }

                this._scheduler.runForNotebook(event.notebook);
                this._scheduler.scheduleSweep(4);
            }),
            vscode.window.onDidChangeActiveNotebookEditor(editor => {
                if (!editor) {
                    return;
                }

                void this._selectControllerForEditor(editor);
                initializeEditor(editor);
            }),
            vscode.window.onDidChangeVisibleNotebookEditors(editors => {
                for (const editor of editors) {
                    initializeEditor(editor);
                }
            })
        );

        for (const editor of vscode.window.visibleNotebookEditors) {
            this._ensureControllerAssociation(editor.notebook);
            initializeEditor(editor);
        }
        if (vscode.window.activeNotebookEditor) {
            this._ensureControllerAssociation(vscode.window.activeNotebookEditor.notebook);
            void this._selectControllerForEditor(vscode.window.activeNotebookEditor);
            this._scheduler.runForEditor(vscode.window.activeNotebookEditor);
        }
        this._scheduler.scheduleSweep();
    }

    public dispose(): void {
        this._highlighter.dispose();
        this._controller.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    public async executeHandler(cells: vscode.NotebookCell[], _notebook: vscode.NotebookDocument, _controller: vscode.NotebookController): Promise<void> {
        logExecution('executeHandler start cells=%d notebook=%s activeNotebook=%s visible=%s',
            cells.length,
            uriLabel(_notebook.uri),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri),
            visibleNotebookLabels());

        for (const cell of cells) {
            const executableCell = this._resolveExecutableCell(cell);
            if (!executableCell) {
                warnExecution('executeHandler skipped remote alias cell with no executable notebook: %s', cellLabel(cell));
                continue;
            }

            logExecution('executeHandler cell %s', cellLabel(executableCell));
            const prepared = await this._prepareNotebookForExecution(executableCell.notebook);
            if (!prepared) {
                warnExecution('executeHandler skipped cell because notebook was not prepared: %s', cellLabel(executableCell));
                continue;
            }

            await this._doExecuteCell(executableCell);
        }

        logExecution('executeHandler end notebook=%s', uriLabel(_notebook.uri));
    }

    private async _executeNotebookRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean> {
        logExecution('executeNotebookRanges start notebook=%s ranges=%s visible=%s',
            uriLabel(notebook.uri),
            rangesLabel(ranges),
            visibleNotebookLabels());

        if (ranges.length === 0) {
            logExecution('executeNotebookRanges no ranges notebook=%s', uriLabel(notebook.uri));
            return true;
        }

        const canExecute = await this._prepareNotebookForExecution(notebook);
        if (!canExecute) {
            warnExecution('executeNotebookRanges notebook was not prepared notebook=%s visible=%s',
                uriLabel(notebook.uri),
                visibleNotebookLabels());
            return false;
        }

        const expectedCells = this._getCellsInRanges(notebook, ranges);
        if (expectedCells.length === 0) {
            warnExecution('executeNotebookRanges found no cells notebook=%s ranges=%s',
                uriLabel(notebook.uri),
                rangesLabel(ranges));
            return false;
        }

        logExecution('executeNotebookRanges resolved cells=%d notebook=%s cellIndexes=%s',
            expectedCells.length,
            uriLabel(notebook.uri),
            expectedCells.map(cell => String(cell.index)).join(','));

        const executionVersionsBefore = new Map(
            expectedCells.map(cell => [
                cell.document.uri.toString(),
                this._cellExecutionVersions.get(cell.document.uri.toString()) ?? 0
            ])
        );

        try {
            for (const cell of expectedCells) {
                await this._doExecuteCell(cell);
            }
            const executed = expectedCells.every(cell => {
                const cellKey = cell.document.uri.toString();
                return (this._cellExecutionVersions.get(cellKey) ?? 0) > (executionVersionsBefore.get(cellKey) ?? 0);
            });
            logExecution('executeNotebookRanges end notebook=%s executed=%s',
                uriLabel(notebook.uri),
                String(executed));
            return executed;
        } catch (error) {
            errorExecution('Could not execute notebook cells for %s: %s', notebook.uri.toString(), String(error));
            return false;
        }
    }

    private async _prepareNotebookForExecution(notebook: vscode.NotebookDocument): Promise<boolean> {
        if (isRemoteNotebookAlias(notebook.uri)) {
            warnExecution('prepareNotebook skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
            return false;
        }

        logExecution('prepareNotebook start notebook=%s activeNotebook=%s visible=%s',
            uriLabel(notebook.uri),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri),
            visibleNotebookLabels());

        const editor = vscode.window.visibleNotebookEditors
            .find(candidate => !isRemoteNotebookAlias(candidate.notebook.uri) && notebookUrisMatch(candidate.notebook.uri, notebook.uri));
        if (!editor) {
            warnExecution('prepareNotebook no visible editor notebook=%s visible=%s',
                uriLabel(notebook.uri),
                visibleNotebookLabels());
            return false;
        }

        const selected = await this._selectControllerForEditor(editor);
        logExecution('prepareNotebook end notebook=%s selected=%s activeNotebook=%s',
            uriLabel(notebook.uri),
            String(selected),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
        return selected;
    }

    private async _selectControllerForEditor(editor: vscode.NotebookEditor): Promise<boolean> {
        const { notebook } = editor;
        if (notebook.notebookType !== this.notebookType) {
            logExecution('selectController skipped non-webnb notebookType=%s notebook=%s',
                notebook.notebookType,
                uriLabel(notebook.uri));
            return false;
        }
        if (isRemoteNotebookAlias(notebook.uri)) {
            warnExecution('selectController skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
            return false;
        }

        logExecution('selectController start notebook=%s viewColumn=%s activeNotebook=%s',
            uriLabel(notebook.uri),
            String(editor.viewColumn),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));

        this._ensureControllerAssociation(notebook);

        try {
            if (!vscode.window.activeNotebookEditor || !notebookUrisMatch(vscode.window.activeNotebookEditor.notebook.uri, notebook.uri)) {
                logExecution('selectController showing notebook notebook=%s currentActive=%s',
                    uriLabel(notebook.uri),
                    uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
                await vscode.window.showNotebookDocument(notebook, {
                    viewColumn: editor.viewColumn,
                    preserveFocus: false,
                    preview: false
                });
                logExecution('selectController showed notebook notebook=%s activeNotebook=%s',
                    uriLabel(notebook.uri),
                    uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
            }

            const selected = await vscode.commands.executeCommand<boolean>(SELECT_KERNEL_COMMAND, {
                id: this.id,
                extension: this._extensionId,
                skipIfAlreadySelected: true
            });
            logExecution('selectController command result notebook=%s selected=%s',
                uriLabel(notebook.uri),
                String(selected));
            return selected !== false;
        } catch (error) {
            errorExecution('Could not select notebook controller for %s: %s', notebook.uri.toString(), String(error));
            return false;
        }
    }

    private _getCellsInRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): vscode.NotebookCell[] {
        return ranges.flatMap(range => notebook.getCells(range));
    }

    private _resolveExecutableCell(cell: vscode.NotebookCell): vscode.NotebookCell | undefined {
        if (!isRemoteNotebookAlias(cell.notebook.uri)) {
            return cell;
        }

        const notebook = vscode.workspace.notebookDocuments
            .find(candidate =>
                candidate.notebookType === this.notebookType
                && !isRemoteNotebookAlias(candidate.uri)
                && notebookUrisMatch(candidate.uri, cell.notebook.uri)
            );
        if (!notebook || cell.index < 0 || cell.index >= notebook.cellCount) {
            return undefined;
        }

        return notebook.cellAt(cell.index);
    }

    /** Hides widget cells' source editors so learners see just the widget. */
    private _collapseWidgetCells(editor: vscode.NotebookEditor): void {
        if (editor.notebook.notebookType !== this.notebookType || isRemoteNotebookAlias(editor.notebook.uri)) {
            return;
        }

        const widgetIndexes = editor.notebook.getCells()
            .map((cell, index) => isAutoWidgetCell(cell) ? index : -1)
            .filter(index => index >= 0);

        if (widgetIndexes.length === 0) {
            return;
        }

        setTimeout(() => {
            void this._collapseCellInputs(editor, widgetIndexes);
        }, 700);
    }

    private async _collapseCellInputs(editor: vscode.NotebookEditor, indexes: number[]): Promise<void> {
        const originalSelection = editor.selection;
        const originalSelections = editor.selections;

        try {
            for (const index of indexes) {
                editor.selection = new vscode.NotebookRange(index, index + 1);
                editor.selections = [editor.selection];
                await vscode.commands.executeCommand('notebook.cell.collapseCellInput');
            }
        } finally {
            editor.selection = originalSelection;
            editor.selections = originalSelections;
        }
    }

    private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
        logExecution('cell execute start %s', cellLabel(cell));
        const source = cell.document.getText();
        const { languageId } = cell.document;
        let addons = getCellAddons(cell);
        logExecution('cell source loaded index=%d language=%s sourceLength=%d addonTypes=%s',
            cell.index,
            languageId,
            source.length,
            addons.map(addon => normalizeAddonType(addon.type)).join(',') || '<none>');
        const defaultCapture = getDefaultCaptureAddons(addons, source);
        if (defaultCapture.changed) {
            logExecution('cell default capture addon updated index=%d', cell.index);
            addons = defaultCapture.addons;
            await this._replaceCellAddons(cell, addons);
        }
        const files = await snapshotWorkspaceFiles(cell, addons, languageId, source);
        logExecution('cell snapshots ready index=%d snapshotKeys=%s',
            cell.index,
            Object.keys(files).join(',') || '<none>');

        const output = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json({
                source,
                language: languageId,
                addons,
                files,
                cellUri: cell.document.uri.toString(),
                checkedAt: Date.now(),
            }, WEBNB_OUTPUT_MIME)
        ]);

        try {
            logExecution('cell creating execution %s', cellLabel(cell));
            const exec = this._controller.createNotebookCellExecution(cell);
            logExecution('cell execution created index=%d', cell.index);
            exec.start(Date.now());
            logExecution('cell execution started index=%d', cell.index);
            await exec.replaceOutput(output);
            logExecution('cell output replaced index=%d outputItems=%d', cell.index, output.items.length);
            exec.end(true, Date.now());
            logExecution('cell execution ended index=%d success=true', cell.index);
            const cellKey = cell.document.uri.toString();
            this._cellExecutionVersions.set(cellKey, (this._cellExecutionVersions.get(cellKey) ?? 0) + 1);
            logExecution('cell execute complete %s executionVersion=%d',
                cellLabel(cell),
                this._cellExecutionVersions.get(cellKey) ?? 0);
        } catch (error) {
            errorExecution('Cell execution failed for %s: %s', cellLabel(cell), String(error));
            throw error;
        }
    }

    private async _replaceCellAddons(cell: vscode.NotebookCell, addons: Addon[]): Promise<boolean> {
        const cellIndex = cell.index;
        if (cellIndex < 0) {
            return false;
        }

        const currentMetadata = (cell.metadata ?? {}) as Record<string, unknown>;
        const currentAddons = getCellAddons(cell);
        const currentSerialized = JSON.stringify(currentAddons);
        const nextSerialized = JSON.stringify(addons);
        if (currentSerialized === nextSerialized) {
            return false;
        }

        const metadata: Record<string, unknown> = {
            ...currentMetadata,
            addons
        };

        const edit = new vscode.WorkspaceEdit();
        edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cellIndex, metadata)]);
        return vscode.workspace.applyEdit(edit);
    }

    private async _upsertCellAddon(cell: vscode.NotebookCell, addonType: string, content: string): Promise<void> {
        const currentAddons = getCellAddons(cell);
        const nextAddons = upsertAddon(currentAddons, addonType, content);
        await this._replaceCellAddons(cell, nextAddons);
    }
}
