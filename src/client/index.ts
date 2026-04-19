import { render } from './render';
import errorOverlay from 'vscode-notebook-error-overlay';
import type { ActivationFunction } from 'vscode-notebook-renderer';
import xtermCss from '@xterm/xterm/css/xterm.css';
import styleCss from './style.css';

// Fix the public path so that any async import()'s work as expected.
declare const __webpack_relative_entrypoint_to_root__: string;
declare const scriptUrl: string;

__webpack_public_path__ = new URL(scriptUrl.replace(/[^/]+$/, '') + __webpack_relative_entrypoint_to_root__).toString();

// ----------------------------------------------------------------------------
// This is the entrypoint to the notebook renderer's webview client-side code.
// This contains some boilerplate that calls the `render()` function when new
// output is available. You probably don't need to change this code; put your
// rendering logic inside of the `render()` function.
// ----------------------------------------------------------------------------

export const activate: ActivationFunction = (context) => {
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.textContent = `${xtermCss}\n${styleCss}`;


    return {
        renderOutputItem(outputItem, element) {
            const value = outputItem.json();

            if (!value.addons || !Array.isArray(value.addons)) {
                value.addons = [];
            }


            let shadow = element.shadowRoot;
            if (!shadow) {
                shadow = element.attachShadow({ mode: 'open' });
                shadow.append(style.cloneNode(true));

                const root = document.createElement('div');
                root.id = 'root';
                shadow.append(root);
            }


            const root = shadow.querySelector<HTMLElement>('#root')!;
            errorOverlay.wrap(root, () => {
                const cleanup = (root as any).__webnbCleanup;
                if (typeof cleanup === 'function') {
                    cleanup();
                }
                delete (root as any).__webnbCleanup;
                root.innerHTML = '';

                const feedback = document.createElement('div');
                feedback.classList.add('feedback');
                const consoleElement = document.createElement('div');
                consoleElement.classList.add('console');

                const node = document.createElement('div');
                node.setAttribute('id', 'html-output');
                root.append(feedback, node, consoleElement);

                function addStyle(css: string) {
                    const style = document.createElement('style');
                    style.setAttribute('type', 'text/css');
                    style.textContent = css;
                    if (shadow) {
                        shadow.insertBefore(style, root);
                    }
                }

                const nextCleanup = render({ feedback, container: node, mime: outputItem.mime, style, value, context, console: consoleElement, addStyle });
                if (typeof nextCleanup === 'function') {
                    (root as any).__webnbCleanup = nextCleanup;
                }
            });
        },
        disposeOutputItem(outputId) {
            // Do any teardown here. outputId is the cell output being deleted, or
            // undefined if we're clearing all outputs.
        }
    };
};
