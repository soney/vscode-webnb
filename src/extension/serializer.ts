import * as vscode from 'vscode';
import { parseMarkdown, RawNotebookCell, writeCellsToMarkdown, type WebNbCellMetadata } from './markdownParser';
import { isAutoWidgetLanguage } from '../shared/addons';

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

/**
 * Cells that open with their source collapsed: the self-rendering widget
 * languages, plus anything flagged `hidecode`. The widget set comes from
 * shared/addons so this cannot drift from what the renderer treats as a widget
 * -- which also fixes `{external}`/`{checklist}`, documented in SYNTAX.md as
 * collapsing like `{mcq}` but previously left expanded.
 */
function collapsesInput(data: RawNotebookCell): boolean {
	return data.hidecode === true || isAutoWidgetLanguage(data.language);
}

function rawToNotebookCellData(data: RawNotebookCell): vscode.NotebookCellData {
	const metadata: WebNbCellMetadata = {
		leadingWhitespace: data.leadingWhitespace,
		trailingWhitespace: data.trailingWhitespace,
		indentation: data.indentation,
		addons: data.addons,
		addonWhitespace: data.addonWhitespace,
		id: data.id,
		autorun: data.autorun,
		runonstart: data.runonstart,
		hidecode: data.hidecode,
		height: data.height,
		// Widget cells and `hidecode` cells open with their source collapsed:
		// what matters about them is what they draw, not the code behind it.
		// This is as far as the notebook API goes -- a reader can still expand
		// the input -- so `hidecode` is for cells whose code is noise, not for
		// keeping an answer secret. (`+solution` and `webnb.allowRevealingSolutions`
		// are the feature for that.)
		...(collapsesInput(data) ? { inputCollapsed: true } : {})
	};
	return <vscode.NotebookCellData>{
		kind: data.kind,
		languageId: data.language,
		metadata,
		value: data.content
	};
}
