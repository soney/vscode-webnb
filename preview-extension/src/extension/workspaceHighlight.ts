/**
 * Draws what a reader is hovering in a walkthrough onto the real editors that
 * already show the file, and opens a file a cell links to.
 *
 * The notebook extension does this from its kernel (walkthroughHighlighter.ts);
 * the preview needs the same behaviour driven from a text document instead of a
 * notebook cell.
 */
import * as vscode from 'vscode';
import { resolveWorkspaceFileUri } from './documentSnapshots';

export class WorkspaceLineHighlighter implements vscode.Disposable {
    /** The lines a hovered walkthrough step shows, marked in open editors. */
    private readonly regionDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });

    /** The single line under the pointer, marked more strongly inside that region. */
    private readonly lineDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('focusBorder'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });

    private key: string | undefined;

    /** Drops the hover highlight wherever it is currently drawn. */
    public clear(): void {
        if (this.key === undefined) {
            return;
        }
        this.key = undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.regionDecoration, []);
            editor.setDecorations(this.lineDecoration, []);
        }
    }

    /**
     * Highlights the step's shown ranges plus the one line under the pointer, in
     * editors that already show the file, scrolling to it when it sits outside
     * the viewport. Files that are not open are left alone: hovering should
     * never open an editor.
     *
     * `notebookUri` is the .webnb document being previewed -- what a cell's
     * relative `requestPath` resolves against.
     */
    public highlight(
        notebookUri: vscode.Uri,
        requestPath?: string,
        ranges?: { start: number; end: number }[],
        line?: number
    ): void {
        const uri = requestPath ? resolveWorkspaceFileUri(notebookUri, requestPath) : undefined;
        const hasTarget = !!uri && ((ranges?.length ?? 0) > 0 || line !== undefined);
        const key = hasTarget
            ? `${uri!.toString()}|${(ranges ?? []).map(range => `${range.start}-${range.end}`).join(',')}|${line ?? ''}`
            : undefined;
        if (key === this.key) {
            return;
        }
        if (!key) {
            this.clear();
            return;
        }
        this.key = key;

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() !== uri?.toString()) {
                editor.setDecorations(this.regionDecoration, []);
                editor.setDecorations(this.lineDecoration, []);
                continue;
            }

            const toRange = (start: number, end: number): vscode.Range => {
                const lastLine = Math.max(0, editor.document.lineCount - 1);
                const first = Math.min(Math.max(0, Math.floor(start) - 1), lastLine);
                const last = Math.min(Math.max(first, Math.floor(end) - 1), lastLine);
                return new vscode.Range(first, 0, last, editor.document.lineAt(last).range.end.character);
            };

            const regionRanges = (ranges ?? []).map(range => toRange(range.start, range.end));
            const lineRanges = line === undefined ? [] : [toRange(line, line)];
            editor.setDecorations(this.regionDecoration, regionRanges);
            editor.setDecorations(this.lineDecoration, lineRanges);

            // Follow the narrowest thing being pointed at.
            const reveal = lineRanges[0] ?? regionRanges[0];
            if (reveal) {
                editor.revealRange(reveal, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }
    }

    public dispose(): void {
        this.regionDecoration.dispose();
        this.lineDecoration.dispose();
    }
}

/** Opens a workspace file a cell referenced, beside the preview. */
export async function openWorkspaceFile(
    notebookUri: vscode.Uri,
    requestPath: string,
    line?: number
): Promise<void> {
    const uri = resolveWorkspaceFileUri(notebookUri, requestPath);
    if (!uri) {
        return;
    }

    const selectionLine = Math.max(0, Math.floor(line ?? 1) - 1);
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const clampedLine = Math.min(selectionLine, Math.max(0, document.lineCount - 1));
        await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
            selection: new vscode.Range(clampedLine, 0, clampedLine, 0)
        });
    } catch (error) {
        console.warn('[webnb-preview] openWorkspaceFile failed path=%s error=%s', requestPath, String(error));
    }
}
