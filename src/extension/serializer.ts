// import { TextDecoder, TextEncoder } from "util";
import * as vscode from 'vscode';
import { parseMarkdown, RawNotebookCell, writeCellsToMarkdown } from './markdownParser';

declare class TextDecoder {
	decode(data: Uint8Array): string;
}
declare class TextEncoder {
	encode(data: string): Uint8Array;
}

const providerOptions: vscode.NotebookDocumentContentOptions = {
    // transientOutputs: true,
    // transientCellMetadata: {
    //     inputCollapsed: true,
    //     outputCollapsed: true,
    // },
};

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
	return <vscode.NotebookCellData>{
		kind: data.kind,
		languageId: data.language,
		metadata: { 
			leadingWhitespace: data.leadingWhitespace, 
			trailingWhitespace: data.trailingWhitespace, 
			indentation: data.indentation, 
			addons: data.addons,
			id: data.id
		},
		// outputs: []
		// new vscode.NotebookCellOutput([
		// 	vscode.NotebookCellOutputItem.text("dummy output text", 'text/plain')
		// ])],
		value: data.content
	};
}

// interface RawNotebook {
//     cells: RawNotebookCell[];
// }

// interface RawNotebookCell {
//     source: string[];
//     cell_type: 'code' | 'markdown';
// }

// class SampleSerializer implements vscode.NotebookSerializer {
//   async deserializeNotebook(
//     content: Uint8Array,
//     _token: vscode.CancellationToken
//   ): Promise<vscode.NotebookData> {
//         const contents = new TextDecoder().decode(content);

//         let raw: RawNotebookCell[];
//         try {
//             raw = (<RawNotebook>JSON.parse(contents)).cells;
//         } catch {
//             raw = [];
//         }

//         const cells = raw.map(
//             item =>
//                 new vscode.NotebookCellData(
//                 item.cell_type === 'code'
//                     ? vscode.NotebookCellKind.Code
//                     : vscode.NotebookCellKind.Markup,
//                 item.source.join('\n'),
//                 item.cell_type === 'code' ? 'python' : 'markdown'
//                 )
//         );

//         return new vscode.NotebookData(cells);
//   }

//   async serializeNotebook(
//     data: vscode.NotebookData,
//     _token: vscode.CancellationToken
//   ): Promise<Uint8Array> {
//         let contents: RawNotebookCell[] = [];

//         for (const cell of data.cells) {
//         contents.push({
//             cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
//             source: cell.value.split(/\r?\n/g)
//         });
//         }

//         return new TextEncoder().encode(JSON.stringify(contents));
//     }
// }