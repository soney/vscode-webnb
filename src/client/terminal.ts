/**
 * The simulated terminal for exercise cells: a persistent per-cell session
 * (history survives re-renders, and a reload through the cell's `+history`
 * addon), an xterm view when the cell carries a `+terminal` addon, and the
 * `terminal` API (`run`/`history`/`didRun`/...) exposed to check code. Command
 * output is simulated — nothing executes.
 */
import { Terminal } from '@xterm/xterm';

export interface ParsedTerminalAddon {
    prompt: string;
    welcome?: string;
    run: string[];
}

export interface TerminalSessionState {
    history: string[];
    prompt: string;
    welcomeShown: boolean;
    restoreFocus: boolean;
    startupRan: boolean;
}

const DEFAULT_TERMINAL_PROMPT = '$';

/** Sessions are keyed by cell URI so a cell's history survives re-renders. */
const terminalSessions = new Map<string, TerminalSessionState>();

/** Drops these cells' sessions (Restore Notebook cleared their saved history). */
export function forgetTerminalSessions(cellKeys: readonly string[]): void {
    for (const key of cellKeys) {
        terminalSessions.delete(key);
    }
}

export function parseTerminalAddon(content: string): ParsedTerminalAddon {
    const parsed: ParsedTerminalAddon = {
        prompt: DEFAULT_TERMINAL_PROMPT,
        run: []
    };

    for (const rawLine of content.split(/\r?\n/g)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const runMatch = line.match(/^run\s*:\s*(.+)$/i);
        if (runMatch) {
            parsed.run.push(runMatch[1].trim());
            continue;
        }

        const promptMatch = line.match(/^prompt\s*:\s*(.+)$/i);
        if (promptMatch) {
            parsed.prompt = promptMatch[1].trim() || DEFAULT_TERMINAL_PROMPT;
            continue;
        }

        const welcomeMatch = line.match(/^welcome\s*:\s*(.+)$/i);
        if (welcomeMatch) {
            parsed.welcome = welcomeMatch[1].trim();
            continue;
        }

        const listRunMatch = line.match(/^[-*]\s+(.+)$/);
        if (listRunMatch) {
            parsed.run.push(listRunMatch[1].trim());
        }
    }

    return parsed;
}

export interface TerminalApi {
    /** Runs a command as if typed at the prompt; returns its simulated output. */
    run(command: string): string;
    history(): string[];
    clear(): void;
    last(): string | undefined;
    didRun(command: string): boolean;
}

export interface TerminalControllerOptions {
    widgetHost: HTMLElement;
    cellKey: string;
    config: ParsedTerminalAddon | undefined;
    /** Called after a command runs (typed or via `terminal.run`), so external
     * checklists can re-check command history. */
    onCommandRan: (command: string) => void;
    /** History saved in the cell's `+history` addon, for a fresh session. */
    savedHistory?: string[];
    /** Called whenever the history changes, so it can be saved to the cell. */
    onHistoryChanged?: (history: string[]) => void;
}

/** Reads a `+history` addon: `{"commands": [...]}`. Anything else is no history. */
export function parseTerminalHistoryAddon(content: string | undefined): string[] | undefined {
    if (!content || !content.trim()) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(content);
        const commands = parsed && typeof parsed === 'object' ? (parsed as { commands?: unknown }).commands : undefined;
        return Array.isArray(commands) && commands.every(command => typeof command === 'string') ? commands : undefined;
    } catch {
        return undefined;
    }
}

export function serializeTerminalHistoryAddon(history: string[]): string {
    return JSON.stringify({ commands: history });
}

/** xterm draws on a canvas and cannot resolve CSS variables, so read their values. */
function themeColor(element: HTMLElement, variable: string, fallback: string): string {
    return getComputedStyle(element).getPropertyValue(variable).trim() || fallback;
}

export interface TerminalController {
    api: TerminalApi;
    state: TerminalSessionState;
    /** Renders the xterm view into the widget host; no-op without a `+terminal` addon. */
    mount(): void;
    dispose(): void;
}

export function createTerminalController({ widgetHost, cellKey, config, onCommandRan, savedHistory, onHistoryChanged }: TerminalControllerOptions): TerminalController {
    const terminalState = terminalSessions.get(cellKey) || {
        history: savedHistory ? savedHistory.slice() : [],
        prompt: config?.prompt || DEFAULT_TERMINAL_PROMPT,
        welcomeShown: false,
        restoreFocus: false,
        // Saved history already includes whatever the startup commands ran.
        startupRan: !!savedHistory
    };
    terminalState.prompt = config?.prompt || terminalState.prompt || DEFAULT_TERMINAL_PROMPT;
    terminalSessions.set(cellKey, terminalState);
    let terminalInstance: Terminal | undefined;
    let terminalInputBuffer = '';

    function getTerminalCommandOutput(command: string, historySnapshot: string[]): string {
        const normalized = command.trim();
        if (!normalized || normalized === 'clear') {
            return '';
        }
        if (normalized === 'history') {
            return historySnapshot.map((cmd, index) => `${index + 1}  ${cmd}`).join('\n');
        }
        if (normalized.startsWith('echo ')) {
            return normalized.slice(5);
        }
        if (normalized === 'pwd') {
            return '/workspace';
        }
        return `simulated command: ${normalized}`;
    }

    // `persist` is off for the addon's startup commands: opening a notebook
    // must not write to it.
    function runTerminalCommand(command: string, term?: Terminal, persist = true): string {
        const normalized = command.trim();
        if (!normalized) {
            return '';
        }

        terminalState.history.push(normalized);
        if (persist) {
            onHistoryChanged?.(terminalState.history.slice());
        }

        if (normalized === 'clear') {
            term?.clear();
            return '';
        }
        return getTerminalCommandOutput(normalized, terminalState.history);
    }

    function mountTerminal(): void {
        if (!config) {
            return;
        }

        const terminalWrapper = document.createElement('div');
        terminalWrapper.classList.add('webnb-terminal-wrapper');
        const terminalLabel = document.createElement('div');
        terminalLabel.classList.add('webnb-terminal-label');
        terminalLabel.textContent = 'Terminal (simulation)';
        const terminalHost = document.createElement('div');
        terminalHost.classList.add('webnb-terminal');
        terminalWrapper.append(terminalLabel, terminalHost);

        widgetHost.prepend(terminalWrapper);

        terminalInstance = new Terminal({
            cols: 80,
            rows: 14,
            convertEol: true,
            disableStdin: false,
            theme: {
                background: themeColor(widgetHost, '--vscode-editor-background', '#1e1e1e'),
                foreground: themeColor(widgetHost, '--vscode-editor-foreground', '#d4d4d4'),
                cursor: themeColor(widgetHost, '--vscode-editorCursor-foreground', '#aeafad'),
                selectionBackground: themeColor(widgetHost, '--vscode-editor-selectionBackground', '#264f78')
            }
        });
        terminalInstance.open(terminalHost);

        if (!terminalState.welcomeShown) {
            terminalInstance.writeln(config.welcome || 'Type commands here. This terminal is simulated for exercises.');
            terminalState.welcomeShown = true;
        }

        const writePrompt = () => terminalInstance?.write(`${terminalState.prompt} `);

        if (!terminalState.startupRan) {
            for (const command of config.run) {
                runTerminalCommand(command, undefined, false);
            }
            terminalState.startupRan = true;
        }

        for (let index = 0; index < terminalState.history.length; index++) {
            const command = terminalState.history[index];
            if (command === 'clear') {
                terminalInstance.clear();
                continue;
            }

            terminalInstance.writeln(`${terminalState.prompt} ${command}`);
            const output = getTerminalCommandOutput(command, terminalState.history.slice(0, index + 1));
            if (output) {
                for (const line of output.split(/\r?\n/g)) {
                    terminalInstance.writeln(line);
                }
            }
        }
        writePrompt();

        terminalInstance.onData((data: string) => {
            if (!terminalInstance) {
                return;
            }

            if (data === '\r') {
                const command = terminalInputBuffer;
                terminalInputBuffer = '';
                terminalInstance.write('\r\n');
                const output = runTerminalCommand(command, terminalInstance);
                if (output) {
                    terminalInstance.writeln(output);
                }
                writePrompt();
                onCommandRan(command);
                return;
            }

            if (data === '\u007f') {
                if (terminalInputBuffer.length > 0) {
                    terminalInputBuffer = terminalInputBuffer.slice(0, -1);
                    terminalInstance.write('\b \b');
                }
                return;
            }

            if (data >= ' ' && data <= '~') {
                terminalInputBuffer += data;
                terminalInstance.write(data);
            }
        });

        if (terminalState.restoreFocus) {
            window.requestAnimationFrame(() => {
                terminalInstance?.focus();
                terminalState.restoreFocus = false;
            });
        }
    }

    const terminal = {
        run(command: string): string {
            const result = runTerminalCommand(command, terminalInstance);
            if (terminalInstance) {
                if (command.trim() === 'clear') {
                    terminalInstance.clear();
                } else {
                    terminalInstance.writeln(`${terminalState.prompt} ${command}`);
                }
                if (result) {
                    terminalInstance.writeln(result);
                }
                terminalInstance.write(`${terminalState.prompt} `);
            }
            onCommandRan(command);
            return result;
        },
        history(): string[] {
            return terminalState.history.slice();
        },
        clear(): void {
            terminalState.history.length = 0;
            onHistoryChanged?.([]);
        },
        last(): string | undefined {
            return terminalState.history[terminalState.history.length - 1];
        },
        didRun(command: string): boolean {
            return terminalState.history.some(item => item.trim() === command.trim());
        }
    };

    return {
        api: terminal,
        state: terminalState,
        mount: mountTerminal,
        dispose: () => terminalInstance?.dispose()
    };
}
