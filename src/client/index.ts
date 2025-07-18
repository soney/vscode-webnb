import { render } from './render';
import errorOverlay from 'vscode-notebook-error-overlay';
import type { ActivationFunction } from 'vscode-notebook-renderer';
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
	style.textContent = styleCss;

    return {
        renderOutputItem(outputItem, element) {
            const value = outputItem.json();

            const { addons } = value;
            if(addons && addons.length > 0) {
                for(const { type, content } of addons) {
                    if(type === 'css') {
                        style.textContent += '\n\n' + content;
                    }
                }
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
                root.innerHTML = '';

                const feedback = document.createElement('div');
                feedback.classList.add('feedback');
                const node = document.createElement('div');
                node.setAttribute('id', 'html-output');
                root.append(feedback, node);

                render({ feedback, container: node, mime: outputItem.mime, value, context });
            });
        },
        disposeOutputItem(outputId) {
            // Do any teardown here. outputId is the cell output being deleted, or
            // undefined if we're clearing all outputs.
        }
    };
};
