// We've set up this sample using CSS modules, which lets you import class
// names into JavaScript: https://github.com/css-modules/css-modules
// You can configure or change this in the webpack.config.js file.
import * as style from './style.css';
import type { RendererContext } from 'vscode-notebook-renderer';
import cy from './lite-cy';
// import * as css from "css";

interface IRenderInfo {
    container: HTMLElement;
    feedback: HTMLElement;
    mime: string;
    value: any;
    context: RendererContext<unknown>;
}

// This function is called to render your contents.
export function render({ container, feedback, mime, value }: IRenderInfo) {
    const { language, source, addons } = value;

    if(language === 'html') {
        container.innerHTML = source;

        for(const {type, content} of addons) {
            if(type === 'test') {
                eval(content);
            }
        }

        function assert(selector: string, passMessage: string, failMessage: string) {
            return cy(container, (passed: boolean, message: string, trace: string[]) => {
                if(passed) {
                    addFeedback(`${message}`, 'success');
                } else {
                    addFeedback(`${message}`, 'error');
                }
            }).get(selector);
        }

        function addFeedback(message: string, category:'info' | 'success' | 'error' = 'info') {
            const el = document.createElement('div');
            el.classList.add(category);

            el.innerText = message;
            feedback.append(el);
        }
        // addFeedback(`Rendered HTML with ${source.length} characters.`);
        // try {
        //     cy(container).get('h1').should('exist');
        //     addFeedback('Cypress assertion: h1 exists', 'success');
        // } catch (error) {
        //     addFeedback(`Error in Cypress assertion: ${error}`, 'error');
        // }
//         `<h1>Output!:</h1>
// <div id="outp"></div>
// ${source}
// <script>
// function addToOutput(message) {
// console.log(message);
// const h1 = document.querySelector('h1');
// h1.textContent = 'Output from the web notebook renderer:';
//     const outputDiv = document.querySelector('#outp');
//     if (outputDiv) {
//         const pre = document.createElement('pre');
//         pre.append(message);
//         outputDiv.appendChild(pre);
//     }
// }
// addToOutput('This is a message from the web notebook renderer.');
// </script>`;
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
        // pre.classList.add(style.json);
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
