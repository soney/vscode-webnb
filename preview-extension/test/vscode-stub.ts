/**
 * The sliver of the `vscode` module the parser and serializer touch, so they
 * can run under plain node in tests: the cell-kind enum (values match VS
 * Code's real one), and the log channel serializer.ts creates on import.
 */
export const NotebookCellKind = { Markup: 1, Code: 2 } as const;

export class NotebookCellData {
    public metadata?: unknown;
    constructor(public kind: number, public value: string, public languageId: string) {}
}

const silent = (): void => undefined;

export const window = {
    createOutputChannel(_name: string, _options?: unknown) {
        return { trace: silent, debug: silent, info: silent, warn: silent, error: silent, appendLine: silent, dispose: silent };
    }
};
