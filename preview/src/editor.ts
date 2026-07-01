/**
 * A small editor abstraction over CodeMirror 6, with a <textarea> fallback so a
 * CodeMirror failure can never break the preview.
 */
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

export interface CellEditor {
    dom: HTMLElement;
    getValue(): string;
    setValue(value: string): void;
    focus(): void;
    destroy(): void;
}

export interface EditorOptions {
    doc: string;
    language: string;
    onChange: (value: string) => void;
    onRun?: () => void;
    readOnly?: boolean;
}

function languageExtension(language: string): Extension {
    switch (language) {
        case 'html':
            return html();
        case 'css':
            return css();
        case 'javascript':
        case 'js':
        case 'node':
            return javascript();
        case 'jsx':
        case 'react':
        case 'javascriptreact':
            return javascript({ jsx: true });
        case 'mcq':
            return markdown();
        default:
            return [];
    }
}

function createCodeMirror(options: EditorOptions): CellEditor {
    const extensions: Extension[] = [
        basicSetup,
        languageExtension(options.language),
        oneDark,
        EditorView.lineWrapping,
        keymap.of([
            indentWithTab,
            {
                key: 'Mod-Enter',
                run: () => {
                    options.onRun?.();
                    return true;
                }
            }
        ]),
        EditorView.updateListener.of(update => {
            if (update.docChanged) {
                options.onChange(update.state.doc.toString());
            }
        })
    ];
    if (options.readOnly) {
        extensions.push(EditorView.editable.of(false));
    }

    const view = new EditorView({
        doc: options.doc,
        extensions
    });

    return {
        dom: view.dom,
        getValue: () => view.state.doc.toString(),
        setValue: (value: string) => {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        },
        focus: () => view.focus(),
        destroy: () => view.destroy()
    };
}

function createTextareaFallback(options: EditorOptions): CellEditor {
    const textarea = document.createElement('textarea');
    textarea.className = 'cell-editor-fallback';
    textarea.value = options.doc;
    textarea.spellcheck = false;
    textarea.readOnly = !!options.readOnly;
    textarea.addEventListener('input', () => options.onChange(textarea.value));
    textarea.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            options.onRun?.();
        }
    });
    return {
        dom: textarea,
        getValue: () => textarea.value,
        setValue: (value: string) => { textarea.value = value; },
        focus: () => textarea.focus(),
        destroy: () => textarea.remove()
    };
}

export function createEditor(options: EditorOptions): CellEditor {
    try {
        return createCodeMirror(options);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[webnb-preview] CodeMirror unavailable, using textarea fallback', error);
        return createTextareaFallback(options);
    }
}
