import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new WebNotebookKernel());
}

export function deactivate() {}

export class WebNotebookKernel implements vscode.Disposable, vscode.NotebookController {
    public readonly id = 'webnb-kernel';
    public readonly notebookType = 'web-notebook';
    public readonly label = 'Web Notebook';
    public readonly supportedLanguages = ['javascript', 'html', 'css'];
    public readonly supportsExecutionOrder = false;


    private readonly _controller: vscode.NotebookController;

    public constructor () {
        this._controller = vscode.notebooks.createNotebookController(this.id, this.notebookType, this.label);
        this._controller.supportedLanguages = ['javascript', 'html', 'css', 'js'];
        this._controller.description = "Web Notebook";
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.executeHandler.bind(this);
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
    }

    public executeHandler(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument, controller: vscode.NotebookController): void {
        for (const cell of cells) {
            this._doExecuteCell(cell);
        }
    }

    private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
        const source = cell.document.getText();
        const { languageId } = cell.document;

        const exec = this._controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        let success:boolean = true;

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
                    language: languageId
                }, 'x-application/webnb-output')
            ]);
            exec.replaceOutput(output);
        }

        exec.end(success, Date.now());
    }

}