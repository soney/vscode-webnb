/**
 * Mirrors walkthrough interactions into real editors: hovering a step
 * highlights the lines it shows in any editor that already has the file open,
 * and clicking a file link opens it beside the notebook.
 */
import * as vscode from 'vscode';
import { warnExecution } from './log';
import { resolveContainedWorkspaceFileUri, resolveWorkspaceFileUri } from './workspaceSnapshots';

export class WalkthroughHighlighter implements vscode.Disposable {
    /** The lines a hovered walkthrough step shows, marked in open editors. */
    private readonly _hoveredRegionDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    /** The single line under the pointer, marked more strongly inside that region. */
    private readonly _hoveredLineDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('focusBorder'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    private _hoveredLineKey: string | undefined;

    public dispose(): void {
        this._hoveredRegionDecoration.dispose();
        this._hoveredLineDecoration.dispose();
    }

    /** Drops the walkthrough hover highlight wherever it is currently drawn. */
    public clear(): void {
        if (this._hoveredLineKey === undefined) {
            return;
        }
        this._hoveredLineKey = undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this._hoveredRegionDecoration, []);
            editor.setDecorations(this._hoveredLineDecoration, []);
        }
    }

    /**
     * Highlights what a reader is hovering in a walkthrough — the step's shown
     * ranges, plus the one line under the pointer — in editors that already show
     * the file, scrolling to it when it sits outside the viewport. Files that are
     * not open are left alone: hovering should never open an editor.
     */
    public highlight(
        cell: vscode.NotebookCell,
        requestPath?: string,
        ranges?: { start: number; end: number }[],
        line?: number
    ): void {
        const uri = requestPath ? resolveWorkspaceFileUri(cell, requestPath) : undefined;
        const hasTarget = !!uri && ((ranges?.length ?? 0) > 0 || line !== undefined);
        const key = hasTarget
            ? `${uri!.toString()}|${(ranges ?? []).map(range => `${range.start}-${range.end}`).join(',')}|${line ?? ''}`
            : undefined;
        if (key === this._hoveredLineKey) {
            return;
        }
        if (!key) {
            this.clear();
            return;
        }
        this._hoveredLineKey = key;

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() !== uri?.toString()) {
                editor.setDecorations(this._hoveredRegionDecoration, []);
                editor.setDecorations(this._hoveredLineDecoration, []);
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
            editor.setDecorations(this._hoveredRegionDecoration, regionRanges);
            editor.setDecorations(this._hoveredLineDecoration, lineRanges);

            // Follow the narrowest thing being pointed at.
            const reveal = lineRanges[0] ?? regionRanges[0];
            if (reveal) {
                editor.revealRange(reveal, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }
    }

    public async open(cell: vscode.NotebookCell, requestPath: string, line?: number): Promise<void> {
        // Opening shows the file's contents, so a symlink out of the workspace is refused.
        const uri = await resolveContainedWorkspaceFileUri(cell, requestPath);
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
            warnExecution('openWorkspaceFile failed path=%s error=%s', requestPath, String(error));
        }
    }
}
