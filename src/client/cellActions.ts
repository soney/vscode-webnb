/**
 * The action strip under a code cell's output: "View solution" (when the cell
 * carries a `+solution` addon and the `webnb.allowRevealingSolutions` setting
 * is on) and "Reset code" (when a `+default` addon differs from what the cell
 * currently says). MCQ cells have their own controls in mcq.ts.
 */
import { renderCodeBlockHtml } from './syntaxHighlight';

/** Maps notebook language ids onto names highlight.js knows. */
const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
    node: 'javascript',
    javascriptreact: 'jsx',
    react: 'jsx'
};

export interface CellActionsOptions {
    host: HTMLElement;
    language: string;
    source: string;
    /** The `+default` addon (starter code); empty when the cell has none. */
    defaultSource: string;
    /** Whether the cell has a `+default` at all: an empty one is an empty starter. */
    hasDefault: boolean;
    /** The `+solution` addon content; undefined when the cell has none. */
    solution?: string;
    /** Whether solutions may be revealed (the webnb.allowRevealingSolutions setting). */
    reveal: boolean;
    /** Posts the reset request to the kernel; absent when the host cannot. */
    onReset?: () => void;
}

/** Unique ids for aria wiring; outputs share one webview document. */
let nextSolutionPanelId = 0;

export function renderCellActions({ host, language, source, defaultSource, hasDefault, solution, reveal, onReset }: CellActionsOptions): void {
    const showSolution = reveal && typeof solution === 'string' && solution.trim().length > 0;
    // An empty `+default` is a real starter (the cell shipped empty), so a
    // learner who typed into an empty exercise can still reset it.
    const showReset = typeof onReset === 'function'
        && hasDefault
        && defaultSource !== source;
    if (!showSolution && !showReset) {
        return;
    }

    const actions = document.createElement('div');
    actions.classList.add('webnb-cell-actions');

    let solutionPanel: HTMLElement | undefined;
    if (showSolution) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.classList.add('webnb-cell-action', 'webnb-solution-toggle');
        toggle.textContent = 'View solution';

        solutionPanel = document.createElement('div');
        solutionPanel.classList.add('webnb-solution-panel');
        solutionPanel.id = `webnb-solution-${nextSolutionPanelId++}`;
        solutionPanel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', solutionPanel.id);
        solutionPanel.innerHTML = renderCodeBlockHtml({
            text: solution,
            lang: HIGHLIGHT_LANGUAGE_ALIASES[language] ?? language
        });

        toggle.addEventListener('click', () => {
            if (!solutionPanel) {
                return;
            }
            solutionPanel.hidden = !solutionPanel.hidden;
            toggle.textContent = solutionPanel.hidden ? 'View solution' : 'Hide solution';
            toggle.setAttribute('aria-expanded', String(!solutionPanel.hidden));
        });
        actions.append(toggle);
    }

    if (showReset) {
        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.classList.add('webnb-cell-action', 'webnb-reset-button');
        resetButton.textContent = 'Reset code';
        resetButton.title = 'Restore this cell to its starter code';
        resetButton.addEventListener('click', () => {
            resetButton.disabled = true;
            onReset?.();
        });
        actions.append(resetButton);
    }

    host.append(actions);
    if (solutionPanel) {
        host.append(solutionPanel);
    }
}
