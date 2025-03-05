// We've set up this sample using CSS modules, which lets you import class
// names into JavaScript: https://github.com/css-modules/css-modules
// You can configure or change this in the webpack.config.js file.
import * as style from './style.css';
import type { RendererContext } from 'vscode-notebook-renderer';
// import * as css from "css";

interface IRenderInfo {
    container: HTMLElement;
    mime: string;
    value: any;
    context: RendererContext<unknown>;
}

// This function is called to render your contents.
export function render({ container, mime, value }: IRenderInfo) {
    const { language, source } = value;

    if(language === 'html') {
        container.innerHTML = source;
    // } else if(language === 'css') {
    //     const ast = css.parse(source);
        
    //     let numSelectors: number = 0;
    //     let numRules: number = 0;
    //     if(ast.stylesheet) {
    //         numSelectors = ast.stylesheet.rules.length;
    //         for (const rule of ast.stylesheet.rules) {
    //             if (rule.type === 'rule') {
    //                 if(rule.selectors) {
    //                     numRules += rule.selectors.length;
    //                 }
    //             }
    //         }
    //     }

    //     container.innerText = `CSS with ${numRules} rules`;
    } else {
        const pre = document.createElement('pre');
        pre.classList.add(style.json);
        const code = document.createElement('code');
        code.textContent = `mime type: ${mime}\n\n${JSON.stringify(value, null, 2)}`;
        pre.appendChild(code);
        container.appendChild(pre);
    }
}

if (module.hot) {
    module.hot.addDisposeHandler(() => {
        // In development, this will be called before the renderer is reloaded. You
        // can use this to clean up or stash any state.
    });
}
