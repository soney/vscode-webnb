/**
 * Execution-path logging for the kernel modules, routed through a
 * LogOutputChannel so verbosity is user-controlled (Output panel ->
 * "Web Notebook" -> gear -> log level). Execution traces log at Trace level —
 * invisible by default, available when debugging autorun/kernel issues.
 */
import * as vscode from 'vscode';

export const logChannel = vscode.window.createOutputChannel('Web Notebook', { log: true });

/** printf-lite: fills %s/%d/%f placeholders, appends any leftover args. */
function format(message: string, args: unknown[]): string {
    let index = 0;
    const formatted = message.replace(/%[sdf]/g, match => {
        if (index >= args.length) {
            return match;
        }
        const value = args[index++];
        return typeof value === 'string' ? value : String(value);
    });
    const rest = args.slice(index).map(value => typeof value === 'string' ? value : JSON.stringify(value));
    return rest.length > 0 ? `${formatted} ${rest.join(' ')}` : formatted;
}

export function logExecution(message: string, ...args: unknown[]): void {
    logChannel.trace(format(message, args));
}

export function warnExecution(message: string, ...args: unknown[]): void {
    logChannel.warn(format(message, args));
}

export function errorExecution(message: string, ...args: unknown[]): void {
    logChannel.error(format(message, args));
}

export function uriLabel(uri: vscode.Uri | undefined): string {
    return uri?.toString() ?? '<none>';
}

export function cellLabel(cell: vscode.NotebookCell): string {
    return `index=${cell.index} kind=${cell.kind} language=${cell.document.languageId} notebook=${uriLabel(cell.notebook.uri)} document=${uriLabel(cell.document.uri)} version=${cell.document.version}`;
}

export function rangesLabel(ranges: vscode.NotebookRange[]): string {
    return ranges.map(range => `${range.start}:${range.end}`).join(',') || '<none>';
}

export function visibleNotebookLabels(): string {
    return vscode.window.visibleNotebookEditors
        .map(editor => uriLabel(editor.notebook.uri))
        .join(' | ') || '<none>';
}
