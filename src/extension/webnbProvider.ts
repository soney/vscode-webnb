import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new WebNotebookKernel());
}

export function deactivate() { }

export class WebNotebookKernel implements vscode.Disposable, vscode.NotebookController {
    public readonly id = 'webnb-kernel';
    public readonly notebookType = 'web-notebook';
    public readonly label = 'Web Notebook';
    public readonly supportedLanguages = ['javascript', 'html', 'css'];
    public readonly supportsExecutionOrder = false;


    private readonly _controller: vscode.NotebookController;
    private readonly _disposables: vscode.Disposable[] = [];

    public constructor() {
        this._controller = vscode.notebooks.createNotebookController(this.id, this.notebookType, this.label);
        this._controller.supportedLanguages = ['javascript', 'html', 'css', 'js', 'mcq'];
        this._controller.description = "Web Notebook";
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.executeHandler.bind(this);
        const runAutorunCells = (notebook: vscode.NotebookDocument) => {
            if (notebook.notebookType === this.notebookType) {
                const cellsToRun = notebook.getCells().filter(c =>
                    c.kind === vscode.NotebookCellKind.Code &&
                    (c.metadata?.autorun || c.document.languageId === 'mcq')
                );
                if (cellsToRun.length > 0) {
                    // Slight delay to allow the kernel to associate with the notebook
                    setTimeout(() => {
                        this.executeHandler(cellsToRun, notebook, this._controller);
                    }, 500);
                }
            }
        };
        const collapseMcqCells = (editor: vscode.NotebookEditor) => {
            if (editor.notebook.notebookType !== this.notebookType) {
                return;
            }

            const mcqIndexes = editor.notebook.getCells()
                .map((cell, index) => cell.document.languageId === 'mcq' ? index : -1)
                .filter(index => index >= 0);

            if (mcqIndexes.length === 0) {
                return;
            }

            setTimeout(() => {
                void this._collapseCellInputs(editor, mcqIndexes);
            }, 700);
        };

        this._disposables.push(
            vscode.workspace.onDidOpenNotebookDocument(runAutorunCells),
            vscode.window.onDidChangeVisibleNotebookEditors(editors => {
                for (const editor of editors) {
                    collapseMcqCells(editor);
                }
            })
        );

        for (const notebook of vscode.workspace.notebookDocuments) {
            runAutorunCells(notebook);
        }
        for (const editor of vscode.window.visibleNotebookEditors) {
            collapseMcqCells(editor);
        }
    }
    createNotebookCellExecution(cell: vscode.NotebookCell): vscode.NotebookCellExecution {
        throw new Error('Method not implemented.');
    }
    public interruptHandler(notebook: vscode.NotebookDocument): void | Thenable<void> {
    }

    public onDidChangeSelectedNotebooks: vscode.Event<{ readonly notebook: vscode.NotebookDocument; readonly selected: boolean; }> = new vscode.EventEmitter<{ readonly notebook: vscode.NotebookDocument; readonly selected: boolean; }>().event;

    public updateNotebookAffinity(notebook: vscode.NotebookDocument, affinity: vscode.NotebookControllerAffinity): void {
        throw new Error('Method not implemented.');
    }

    public dispose(): void {
        this._controller.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    public executeHandler(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument, controller: vscode.NotebookController): void {
        for (const cell of cells) {
            this._doExecuteCell(cell);
        }
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
        const source = cell.document.getText();
        const { languageId } = cell.document;

        const exec = this._controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        let success: boolean = true;

        /*
        if(languageId === 'javascript') {
            try {
                // eslint-disable-next-line no-eval
                const result = await eval(source);
                // this._appendOutput(exec, languageId, source, result);
                exec.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.json(result, 'application/json')
                ]));
            } catch (error) {
                exec.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(new Error(error+''))
                ]));
                success = false;
            }
        } else {
            const output = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json({
                    source,
                    language: languageId,
                    addons: cell.metadata.addons || [],
                }, 'x-application/webnb-output')
            ]);
            exec.replaceOutput(output);
        }
            */
        const output = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json({
                source,
                language: languageId,
                addons: cell.metadata.addons || [],
            }, 'x-application/webnb-output')
        ]);
        exec.replaceOutput(output);

        exec.end(success, Date.now());
    }

}
