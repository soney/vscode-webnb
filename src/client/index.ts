/**
 * The notebook renderer's webview entrypoint: VS Code calls renderOutputItem
 * for each cell output, and this mounts the shared render() pipeline into the
 * output element (see mountRenderer.ts for the DOM contract).
 */
import errorOverlay from 'vscode-notebook-error-overlay';
import type { ActivationFunction } from 'vscode-notebook-renderer';
import { createCellMount, type CellMount } from './mountRenderer';
import type { WebnbOutputValue } from '../shared/protocol';
import xtermCss from '@xterm/xterm/css/xterm.css';
import highlightCss from './syntaxHighlight.css';
import styleCss from './style.css';

// Fix the public path so that any async import()'s work as expected.
declare const __webpack_relative_entrypoint_to_root__: string;
declare const scriptUrl: string;

__webpack_public_path__ = new URL(scriptUrl.replace(/[^/]+$/, '') + __webpack_relative_entrypoint_to_root__).toString();

export const activate: ActivationFunction = (context) => {
    const cssText = `${xtermCss}\n${highlightCss}\n${styleCss}`;
    const mounts = new WeakMap<HTMLElement, CellMount>();
    const mountsByOutputId = new Map<string, CellMount>();

    return {
        renderOutputItem(outputItem, element) {
            const value = outputItem.json();
            // The payload crosses a JSON boundary from the kernel; a malformed
            // one should fail with a clear message, not a downstream TypeError.
            if (!value || typeof value !== 'object' || typeof value.source !== 'string' || typeof value.language !== 'string') {
                throw new Error(`Malformed webnb output payload (mime ${outputItem.mime}): expected { source, language, ... }`);
            }
            if (!value.addons || !Array.isArray(value.addons)) {
                value.addons = [];
            }

            let mount = mounts.get(element);
            if (!mount) {
                mount = createCellMount(element, {
                    cssText,
                    wrapRender: (root, fn) => errorOverlay.wrap(root, fn)
                });
                mounts.set(element, mount);
            }
            mountsByOutputId.set(outputItem.id, mount);
            mount.render(value as WebnbOutputValue, outputItem.mime, context);
        },
        disposeOutputItem(outputId) {
            if (outputId === undefined) {
                for (const mount of mountsByOutputId.values()) {
                    mount.dispose();
                }
                mountsByOutputId.clear();
                return;
            }

            mountsByOutputId.get(outputId)?.dispose();
            mountsByOutputId.delete(outputId);
        }
    };
};
