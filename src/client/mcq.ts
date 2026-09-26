/**
 * Multiple-choice cells: the `mcq` source grammar (question, options,
 * per-option feedback, shuffle flags), persisted-selection handling, and the
 * form UI with answer checking.
 */
import type { Addon } from '../shared/protocol';
import { getAddonContent } from '../shared/addons';
import { dedent } from '../shared/indentation';
import { renderMarkdownBlock, renderMarkdownInline } from './markdown';
import type { FeedbackWriters } from './feedback';

export interface McqOption {
    text: string;
    correct: boolean;
    correctFeedback?: string;
    wrongFeedback?: string;
}
export interface DisplayMcqOption extends McqOption {
    originalIndex: number;
}
export interface ParsedMcq {
    question: string;
    options: McqOption[];
    correctFeedback?: string;
    wrongFeedback?: string;
    shuffle: boolean;
    deterministic: boolean;
}

export function parseMcqSource(source: string): ParsedMcq {
    const lines = source.split(/\r?\n/);
    const options: McqOption[] = [];
    const questionLines: string[] = [];
    let correctFeedback: string | undefined;
    let wrongFeedback: string | undefined;
    let shuffle = true;
    let deterministic = false;
    let sawOption = false;
    let currentOption: McqOption | undefined;
    // A code sample in the question (SYNTAX.md recommends ~~~ fences) is text
    // through and through: `  correct: false,` inside one is a line of code,
    // not feedback, and `[x]` inside one is not an option.
    let openFence: { marker: string; length: number } | undefined;

    for (const line of lines) {
        const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
        if (openFence) {
            if (fence && fence[1][0] === openFence.marker && fence[1].length >= openFence.length && !fence[2].trim()) {
                openFence = undefined;
            }
            questionLines.push(line);
            continue;
        }
        if (fence) {
            openFence = { marker: fence[1][0], length: fence[1].length };
            questionLines.push(line);
            continue;
        }

        const optionMatch = line.match(/^\s*(?:-\s*)?\[([ xX])\]\s*(.*)$/);
        if (optionMatch) {
            sawOption = true;
            currentOption = {
                text: optionMatch[2].trim(),
                correct: optionMatch[1].toLowerCase() === 'x'
            };
            options.push(currentOption);
            continue;
        }

        if (currentOption) {
            const optionCorrectMatch = line.match(/^[ \t]+correct\s*:\s*(.*)$/i);
            if (optionCorrectMatch) {
                currentOption.correctFeedback = optionCorrectMatch[1].trim();
                continue;
            }

            const optionWrongMatch = line.match(/^[ \t]+(?:wrong|incorrect)\s*:\s*(.*)$/i);
            if (optionWrongMatch) {
                currentOption.wrongFeedback = optionWrongMatch[1].trim();
                continue;
            }
        }

        if (!sawOption) {
            const shuffleMatch = line.match(/^\s*shuffle\s*:\s*(.*)$/i);
            if (shuffleMatch) {
                const shuffleValue = shuffleMatch[1].trim().toLowerCase();
                if (shuffleValue === 'deterministic' || shuffleValue === 'stable') {
                    shuffle = true;
                    deterministic = true;
                } else if (shuffleValue === 'random') {
                    shuffle = true;
                    deterministic = false;
                } else {
                    shuffle = parseMcqBooleanFlag(shuffleMatch[1], true);
                }
                continue;
            }

            const deterministicMatch = line.match(/^\s*deterministic\s*:\s*(.*)$/i);
            if (deterministicMatch) {
                deterministic = parseMcqBooleanFlag(deterministicMatch[1], true);
                continue;
            }

            const correctMatch = line.match(/^\s*correct\s*:\s*(.*)$/i);
            if (correctMatch) {
                correctFeedback = correctMatch[1].trim();
                continue;
            }

            const wrongMatch = line.match(/^\s*(?:wrong|incorrect)\s*:\s*(.*)$/i);
            if (wrongMatch) {
                wrongFeedback = wrongMatch[1].trim();
                continue;
            }
        }

        questionLines.push(line);
    }

    return {
        // Dedent before trimming: a cell nested in a list item indents every
        // line of its question, and only the first one loses that indent to
        // trim(). What is left reads to Markdown as an indented code block --
        // and an intentional snippet, indented FURTHER than the question, comes
        // out with the difference doubled. Removing the shared indent leaves
        // any deliberate extra indentation meaning exactly what it meant.
        question: dedent(questionLines.join('\n')).trim(),
        options,
        correctFeedback,
        wrongFeedback,
        shuffle,
        deterministic
    };
}

function parseMcqBooleanFlag(value: string, defaultValue: boolean): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return defaultValue;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function hashMcqShuffleSeed(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

function createSeededMcqRandom(seed: number): () => number {
    let state = seed || 0x9e3779b9;
    return () => {
        state += 0x6d2b79f5;
        let result = state;
        result = Math.imul(result ^ (result >>> 15), result | 1);
        result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
        return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
}

export function getMcqDisplayOptions(options: McqOption[], shuffle: boolean, deterministic: boolean, seedSource: string): DisplayMcqOption[] {
    const displayOptions = options.map((option, originalIndex) => ({
        ...option,
        originalIndex
    }));
    if (!shuffle || displayOptions.length < 2) {
        return displayOptions;
    }

    const random = deterministic ? createSeededMcqRandom(hashMcqShuffleSeed(seedSource)) : Math.random;
    for (let index = displayOptions.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(random() * (index + 1));
        [displayOptions[index], displayOptions[swapIndex]] = [displayOptions[swapIndex], displayOptions[index]];
    }

    return displayOptions;
}

export function parseMcqSelectionAddonContent(content: string, optionCount: number): number[] {
    let rawValues: unknown[] = [];

    const trimmed = content.trim();
    if (!trimmed) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            rawValues = parsed;
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { selected?: unknown[] }).selected)) {
            rawValues = (parsed as { selected: unknown[] }).selected;
        }
    } catch {
        rawValues = trimmed.split(/[\s,]+/g).filter(Boolean);
    }

    const seen = new Set<number>();
    const selections: number[] = [];

    for (const value of rawValues) {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isInteger(numeric) || numeric < 0 || numeric >= optionCount || seen.has(numeric)) {
            continue;
        }
        seen.add(numeric);
        selections.push(numeric);
    }

    return selections;
}

export function serializeMcqSelectionAddonContent(indices: number[]): string {
    return JSON.stringify({ selected: indices });
}

export interface McqCellOptions {
    container: HTMLElement;
    source: string;
    addons: Addon[];
    /** Seed for deterministic option shuffling; stable per cell + source. */
    shuffleSeedSource: string;
    /** Whether answers may be revealed (webnb.allowRevealingSolutions): adds "Show Answer". */
    reveal?: boolean;
    /** The cell's `+solution` addon, shown as the explanation when revealing. */
    solutionContent?: string;
    addFeedback: FeedbackWriters['addFeedback'];
    /** Persists the learner's selection back to the cell's `selection` addon;
     * absent when the renderer cannot reach the extension host. */
    persistSelection?: (content: string) => void;
}

/** Unique ids for aria wiring; outputs share one webview document. */
let nextMcqId = 0;

export function renderMcqCell({ container, source, addons, shuffleSeedSource, reveal, solutionContent, addFeedback, persistSelection }: McqCellOptions): void {
    const { question, options, correctFeedback, wrongFeedback, shuffle, deterministic } = parseMcqSource(source);
    if (!question || options.length === 0) {
        addFeedback('MCQ cells need a question plus at least one option.', 'error');
        return;
    }

    const persistedSelections = parseMcqSelectionAddonContent(
        getAddonContent(addons, 'selection') || getAddonContent(addons, 'mcq-selection') || '',
        options.length
    );
    const persistedSelectionSet = new Set<number>(persistedSelections);

    const numCorrect = options.filter(o => o.correct).length;
    const inputType = numCorrect > 1 ? 'checkbox' : 'radio';
    const displayOptions = getMcqDisplayOptions(options, shuffle, deterministic, shuffleSeedSource);

    const form = document.createElement('form');
    form.classList.add('mcq-form');
    const mcqId = `webnb-mcq-${nextMcqId++}`;

    const questionEl = document.createElement('div');
    questionEl.classList.add('mcq-question');
    questionEl.id = `${mcqId}-question`;
    questionEl.innerHTML = renderMarkdownBlock(question);
    form.appendChild(questionEl);

    // The options are one group named by the question, so a screen reader
    // announces what they answer.
    const optionsGroup = document.createElement('div');
    optionsGroup.classList.add('mcq-options');
    optionsGroup.setAttribute('role', inputType === 'radio' ? 'radiogroup' : 'group');
    optionsGroup.setAttribute('aria-labelledby', questionEl.id);
    form.appendChild(optionsGroup);

    const optionFeedbackEls = new Map<number, HTMLDivElement>();

    displayOptions.forEach(opt => {
        const optionRow = document.createElement('div');
        optionRow.classList.add('mcq-option-row');

        const label = document.createElement('label');
        label.classList.add('mcq-option');

        const input = document.createElement('input');
        input.type = inputType;
        input.name = 'mcq-option';
        input.value = opt.originalIndex.toString();
        input.checked = persistedSelectionSet.has(opt.originalIndex);

        label.appendChild(input);
        const span = document.createElement('span');
        span.innerHTML = renderMarkdownInline(opt.text);
        label.appendChild(span);

        const optionFeedbackEl = document.createElement('div');
        optionFeedbackEl.classList.add('mcq-option-feedback');
        optionFeedbackEl.hidden = true;

        optionFeedbackEls.set(opt.originalIndex, optionFeedbackEl);
        optionRow.append(label, optionFeedbackEl);
        optionsGroup.appendChild(optionRow);
    });

    const checkBtn = document.createElement('button');
    checkBtn.textContent = 'Check Answer';
    checkBtn.type = 'button';
    checkBtn.classList.add('mcq-check-button');

    const persistSelectionState = () => {
        if (!persistSelection) {
            return;
        }

        const selectedIndexes = Array.from(form.querySelectorAll<HTMLInputElement>('input'))
            .map(input => (input.checked ? Number(input.value) : -1))
            .filter(index => Number.isInteger(index) && index >= 0 && index < options.length)
            .sort((left, right) => left - right);

        persistSelection(serializeMcqSelectionAddonContent(selectedIndexes));
    };

    form.querySelectorAll<HTMLInputElement>('input').forEach(input => {
        input.addEventListener('change', () => {
            persistSelectionState();
        });
    });

    checkBtn.addEventListener('click', () => {
        persistSelectionState();
        const inputs = form.querySelectorAll<HTMLInputElement>('input');
        const checkedInputs = Array.from(inputs).filter(input => input.checked);

        optionFeedbackEls.forEach(el => {
            el.hidden = true;
            el.className = 'mcq-option-feedback';
            el.textContent = '';
        });

        if (checkedInputs.length === 0) {
            addFeedback('Select at least one answer before checking.', 'error');
            return;
        }

        let allCorrect = true;
        const checkedIndexes = new Set(
            checkedInputs
                .map(input => Number(input.value))
                .filter(index => Number.isInteger(index) && index >= 0 && index < options.length)
        );

        displayOptions.forEach(opt => {
            const itemIsCorrect = checkedIndexes.has(opt.originalIndex) === opt.correct;
            if (!itemIsCorrect) {
                allCorrect = false;
            }

            const itemFeedback = itemIsCorrect ? opt.correctFeedback : opt.wrongFeedback;
            if (itemFeedback) {
                const optionFeedbackEl = optionFeedbackEls.get(opt.originalIndex);
                if (optionFeedbackEl) {
                    optionFeedbackEl.hidden = false;
                    optionFeedbackEl.classList.add(itemIsCorrect ? 'success' : 'error');
                    // Right and wrong must not be told apart by color alone: the
                    // stylesheet adds a mark, and this says it in words.
                    const verdict = document.createElement('span');
                    verdict.classList.add('webnb-visually-hidden');
                    verdict.textContent = itemIsCorrect ? 'Correct: ' : 'Incorrect: ';
                    optionFeedbackEl.innerHTML = renderMarkdownInline(itemFeedback);
                    optionFeedbackEl.prepend(verdict);
                }
            }
        });

        if (allCorrect) {
            addFeedback(renderMarkdownInline(correctFeedback || 'Correct!'), 'success', true);
        } else {
            addFeedback(renderMarkdownInline(wrongFeedback || 'Incorrect. Try again.'), 'error', true);
        }
    });

    form.appendChild(checkBtn);

    if (reveal) {
        const revealBtn = document.createElement('button');
        revealBtn.textContent = 'Show Answer';
        revealBtn.type = 'button';
        revealBtn.classList.add('mcq-reveal-button');

        const solutionEl = document.createElement('div');
        solutionEl.classList.add('mcq-solution');
        solutionEl.id = `${mcqId}-solution`;
        solutionEl.hidden = true;
        revealBtn.setAttribute('aria-expanded', 'false');
        revealBtn.setAttribute('aria-controls', solutionEl.id);

        let revealed = false;
        revealBtn.addEventListener('click', () => {
            revealed = !revealed;
            revealBtn.textContent = revealed ? 'Hide Answer' : 'Show Answer';
            revealBtn.setAttribute('aria-expanded', String(revealed));

            // Marks the correct options without touching the learner's own
            // selection; checking still grades what they actually chose.
            displayOptions.forEach(opt => {
                const optionFeedbackEl = optionFeedbackEls.get(opt.originalIndex);
                const label = optionFeedbackEl?.parentElement?.querySelector('.mcq-option');
                label?.classList.toggle('mcq-revealed-correct', revealed && opt.correct);
            });

            if (solutionContent && solutionContent.trim()) {
                solutionEl.hidden = !revealed;
                if (revealed && !solutionEl.innerHTML) {
                    solutionEl.innerHTML = renderMarkdownBlock(solutionContent);
                }
            }
        });

        form.appendChild(revealBtn);
        form.appendChild(solutionEl);
    }

    container.appendChild(form);
}
