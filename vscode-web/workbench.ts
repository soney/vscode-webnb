/* eslint-disable no-restricted-globals */
import { create } from "vs/workbench/workbench.web.main";
import { URI, UriComponents } from "vs/base/common/uri";
import { IWorkbenchConstructionOptions } from "vs/workbench/browser/web.api";
import { IWorkspace, IWorkspaceProvider } from "vs/workbench/services/host/browser/browserHostService";
declare const window: any;

(async function () {
    // create workbench
    let config: IWorkbenchConstructionOptions & {
        folderUri?: UriComponents;
        workspaceUri?: UriComponents;
        domElementId?: string;
    } = {};

    if (window.product) {
        config = window.product;
    } else {
        const result = await fetch("/product.json");
        config = await result.json();

        try {
            const result = await fetch("/product.local.json");
            const localConfig = await result.json();
            config = deepExtend(config, localConfig);
        } catch (e) {
            // ignore
        }
    }

    const locationCommand = {
        id: "gamma-samples-extension.location",
        handler: (action?: 'get' | 'set', part?: 'search' | 'hash', newValue?: string) => {
            if (action === 'get') {
                if (part === 'search') {
                    return location.search;
                } else if (part === 'hash') {
                    return location.hash;
                } else {
                    return location.toString();
                }
            } else if (action === 'set' && newValue !== undefined) {
                if (part === 'search') {
                    location.search = newValue;
                    return `Set search to ${newValue}`;
                } else if (part === 'hash') {
                    location.hash = newValue;
                    return `Set hash to ${newValue}`;
                } else {
                    return "Invalid part for setting location";
                }
            } else {
                return "Invalid action or missing value for setting";
            }
        }
    };

    const tempConfig = { ...config };
    tempConfig.commands = Array.isArray(config.commands) ? [...config.commands, locationCommand] : [locationCommand];
    config = tempConfig;

    if (Array.isArray(config.additionalBuiltinExtensions)) {
        const tempConfig = { ...config };
        const defaultScheme = location.protocol.replace(/:$/, '');

        tempConfig.additionalBuiltinExtensions = config.additionalBuiltinExtensions.map((ext) => URI.revive({...ext, scheme: ext.scheme ?? defaultScheme}));
        config = tempConfig;
    }

    let workspace;
    if (config.folderUri) {
        workspace = { folderUri: URI.revive(config.folderUri) };
    } else if (config.workspaceUri) {
        workspace = { workspaceUri: URI.revive(config.workspaceUri) };
    } else {
        workspace = undefined;
    }

    if (workspace) {
        const workspaceProvider: IWorkspaceProvider = {
            workspace,
            open: async (
                workspace: IWorkspace,
                options?: { reuse?: boolean; payload?: object }
            ) => true,
            trusted: true,
        };
        config = { ...config, workspaceProvider };
    }

    const domElement = (!!config.domElementId && document.getElementById(config.domElementId)) || document.body;

    create(domElement, config);
})();


function isObject(item: any): boolean {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

function deepExtend(target: any, source: any): any {
    const output: any = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                }
                else {
                    output[key] = deepExtend(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}
