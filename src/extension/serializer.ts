import * as vscode from 'vscode';
import { parseMarkdown, RawNotebookCell, writeCellsToMarkdown, type WebNbCellMetadata } from './markdownParser';

const providerOptions: vscode.NotebookDocumentContentOptions = {};

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer('web-notebook', new MarkdownProvider(), providerOptions)
    );
}

export function deactivate() {}

class MarkdownProvider implements vscode.NotebookSerializer {
    private readonly decoder = new TextDecoder();
    private readonly encoder = new TextEncoder();

    public constructor() {}

    public deserializeNotebook(data: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData | Thenable<vscode.NotebookData> {
		const content = this.decoder.decode(data);

		const cellRawData = parseMarkdown(content);
		const cells = cellRawData.map(rawToNotebookCellData);

		return { cells };
	}

	public serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array | Thenable<Uint8Array> {
		const stringOutput = writeCellsToMarkdown(data.cells);
		return this.encoder.encode(stringOutput);
	}
}

function rawToNotebookCellData(data: RawNotebookCell): vscode.NotebookCellData {
	const metadata: WebNbCellMetadata = {
		leadingWhitespace: data.leadingWhitespace,
		trailingWhitespace: data.trailingWhitespace,
		indentation: data.indentation,
		addons: data.addons,
		id: data.id,
		autorun: data.autorun,
		runonstart: data.runonstart,
		...(data.language === 'mcq' || data.language === 'walkthrough' ? { inputCollapsed: true } : {})
	};
	return <vscode.NotebookCellData>{
		kind: data.kind,
		languageId: data.language,
		metadata,
		value: data.content
	};
}
