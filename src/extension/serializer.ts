import * as vscode from 'vscode';
import { parseMarkdown, RawNotebookCell, writeCellsToMarkdown, type ParseWarningHandler, type WebNbCellMetadata } from './markdownParser';
import { warnExecution } from './log';

const providerOptions: vscode.NotebookDocumentContentOptions = {
    // Outputs are never written to the file (the kernel rebuilds them on every
    // run), so producing one must not dirty the notebook. Without this every
    // execution -- autorun, a checklist poll -- made the file look edited, and
    // with autosave on it was rewritten each time.
    //
    // No cell metadata is transient: all of it is either layout the writer
    // needs (whitespace, indentation, fence attributes) or learner state that
    // belongs in the file (`+selection`, `+history`, a captured `+default`).
    transientOutputs: true
};

/** The UTF-8 byte order mark, as bytes. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * Notebook metadata recording how the file was encoded, so a save writes it
 * the same way. Absent keys mean the defaults: LF line endings, no BOM.
 */
export interface WebNbNotebookMetadata {
    lineEnding?: '\r\n';
    byteOrderMark?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer('web-notebook', new MarkdownProvider(), providerOptions)
    );
}

export function deactivate() {}

class MarkdownProvider implements vscode.NotebookSerializer {
    public constructor() {}

    public deserializeNotebook(data: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData | Thenable<vscode.NotebookData> {
        return deserializeWebnb(data, message => warnExecution('Web Notebook: %s', message));
    }

    public serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array | Thenable<Uint8Array> {
        return serializeWebnb(data);
    }
}

function hasByteOrderMark(data: Uint8Array): boolean {
    return data.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => data[index] === byte);
}

/** CRLF when most line breaks in the text are CRLF; a mixed file settles on the majority. */
function detectLineEnding(content: string): '\r\n' | undefined {
    const crlf = content.match(/\r\n/g)?.length ?? 0;
    const lf = (content.match(/\n/g)?.length ?? 0) - crlf;
    return crlf > lf ? '\r\n' : undefined;
}

/**
 * The .webnb bytes as notebook data. Also used to compare an open notebook
 * with the file on disk, so it must stay free of side effects.
 */
export function deserializeWebnb(data: Uint8Array, onWarning?: ParseWarningHandler): vscode.NotebookData {
    // TextDecoder drops a leading BOM by default, so look for it in the bytes.
    const content = new TextDecoder().decode(data);
    const metadata: WebNbNotebookMetadata = {};
    const lineEnding = detectLineEnding(content);
    if (lineEnding) {
        metadata.lineEnding = lineEnding;
    }
    if (hasByteOrderMark(data)) {
        metadata.byteOrderMark = true;
    }

    const cells = parseMarkdown(content, onWarning).map(rawToNotebookCellData);
    return { cells, metadata };
}

export function serializeWebnb(data: vscode.NotebookData): Uint8Array {
    const metadata = (data.metadata ?? {}) as WebNbNotebookMetadata;
    let text = writeCellsToMarkdown(data.cells);
    if (metadata.lineEnding === '\r\n') {
        text = text.replace(/\r?\n/g, '\r\n');
    }
    const encoded = new TextEncoder().encode(text);
    if (!metadata.byteOrderMark) {
        return encoded;
    }
    const withBom = new Uint8Array(UTF8_BOM.length + encoded.length);
    withBom.set(UTF8_BOM, 0);
    withBom.set(encoded, UTF8_BOM.length);
    return withBom;
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
        fenceAttributes: data.fenceAttributes,
        languageAlias: data.languageAlias
        // Widget and `hidecode` cells open with their source collapsed, but not
        // through metadata: VS Code reads a cell's collapse state from view
        // state and ignores `inputCollapsed` here. The kernel collapses them
        // with the collapse command instead (see inputCollapser.ts).
    };
    return <vscode.NotebookCellData>{
        kind: data.kind,
        languageId: data.language,
        metadata,
        value: data.content
    };
}
