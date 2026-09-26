/**
 * Follows a link clicked in a markup cell of the preview.
 *
 * The notebook resolves these in src/extension/notebookLinkNavigator.ts with
 * the grammar in src/shared/notebookLinks.ts; this uses the same grammar, so a
 * link means the same thing in both views:
 *
 *  - `other.webnb`, `other.webnb#section`, `../x.webnb`, `sub/a%20b.webnb`:
 *    opens that notebook -- as its Markdown source, since this is the
 *    authoring view (a preview following the editor then moves to it) -- with
 *    the cursor on the section's cell. A leading `/` is the workspace root.
 *  - `#section`: scrolls this preview (and its source editor) to the section.
 *  - anything else relative is a file, opened beside the preview.
 *
 * Missing notebooks, files, and sections are reported the way the notebook
 * reports them, with a warning instead of a silent no-op.
 */
import * as vscode from 'vscode';
import { findSectionCell, parseNotebookLinkHref, WEBNB_FILE_EXTENSION } from '@webnb/shared/notebookLinks';
import { parseDocumentCells } from './parseDocument';

/** VS Code's built-in text editor, as "Reopen Editor With..." names it. */
const TEXT_EDITOR_VIEW_TYPE = 'default';

export interface LinkContext {
    /** The notebook the link was clicked in. */
    document: vscode.TextDocument;
    /** The column of its source editor: another notebook opens there. */
    viewColumn?: vscode.ViewColumn;
    /** Bring a line of `document` into view in the preview and its editor. */
    showLine(line: number): void;
}

/**
 * The first line of the cell that holds a section's heading, or undefined when
 * the notebook has no such section (or does not parse right now).
 */
export function sectionLine(text: string, section: string): number | undefined {
    let cells;
    try {
        cells = parseDocumentCells(text);
    } catch {
        return undefined;
    }
    const index = findSectionCell(cells.map(cell => (cell.kind === 'markup' ? cell.value : undefined)), section);
    return index === undefined ? undefined : cells[index].startLine;
}

/** Percent-escapes as the author's Markdown produced them; bad escapes taken literally. */
function decode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function workspaceFolderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

/** Relative to the linking notebook, or to the workspace root for a leading `/`. */
function resolveLinkUri(sourceUri: vscode.Uri, linkPath: string): vscode.Uri | undefined {
    if (!linkPath.startsWith('/')) {
        return vscode.Uri.joinPath(sourceUri, '..', linkPath);
    }
    const folder = workspaceFolderFor(sourceUri);
    return folder ? vscode.Uri.joinPath(folder.uri, linkPath) : undefined;
}

function fileName(uri: vscode.Uri): string {
    return uri.path.split('/').pop() || uri.path;
}

async function exists(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
        return await vscode.workspace.fs.stat(uri);
    } catch {
        return undefined;
    }
}

export async function followLink(href: string, context: LinkContext): Promise<void> {
    const target = parseNotebookLinkHref(href);
    if (!target) {
        await openFile(href, context);
        return;
    }

    if (!target.path) {
        const line = sectionLine(context.document.getText(), target.section);
        if (line === undefined) {
            void vscode.window.showWarningMessage(`This notebook has no section called "#${target.section}".`);
            return;
        }
        context.showLine(line);
        return;
    }

    const uri = resolveLinkUri(context.document.uri, target.path);
    if (!uri || !uri.path.toLowerCase().endsWith(WEBNB_FILE_EXTENSION)) {
        void vscode.window.showWarningMessage(
            `The link "${href}" points outside this workspace, so there is nothing to open.`
        );
        return;
    }
    if (!await exists(uri)) {
        void vscode.window.showWarningMessage(`There is no notebook at "${href}".`);
        return;
    }

    let selection: vscode.Range | undefined;
    let missingSection = false;
    if (target.section) {
        const text = (await vscode.workspace.openTextDocument(uri)).getText();
        const line = sectionLine(text, target.section);
        if (line === undefined) {
            missingSection = true;
        } else {
            selection = new vscode.Range(line, 0, line, 0);
        }
    }

    await vscode.commands.executeCommand('vscode.openWith', uri, TEXT_EDITOR_VIEW_TYPE, {
        viewColumn: context.viewColumn ?? vscode.ViewColumn.One,
        preview: false,
        selection
    });
    if (missingSection) {
        void vscode.window.showWarningMessage(`"${fileName(uri)}" has no section called "#${target.section}".`);
    }
}

/** A relative link that is not a notebook: open the file beside the preview. */
async function openFile(href: string, context: LinkContext): Promise<void> {
    // Schemes stay the webview's business; the page never sends them here.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        return;
    }
    const linkPath = decode(href.replace(/[?#].*$/, ''));
    if (!linkPath) {
        return;
    }

    const uri = resolveLinkUri(context.document.uri, linkPath);
    const stat = uri ? await exists(uri) : undefined;
    if (!uri || !stat) {
        void vscode.window.showWarningMessage(`There is no file at "${href}".`);
        return;
    }
    if (stat.type & vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
    }
    // vscode.open picks the file's own editor: text, image preview, ...
    await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}
