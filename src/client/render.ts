// We've set up this sample using CSS modules, which lets you import class
// names into JavaScript: https://github.com/css-modules/css-modules
// You can configure or change this in the webpack.config.js file.
import * as style from './style.css';
import type { RendererContext } from 'vscode-notebook-renderer';
import cy from './lite-cy';
import ConsoleObjectView from './consoleobjectview';
// import * as css from "css";

interface IRenderInfo {
    container: HTMLElement;
    feedback: HTMLElement;
    console: HTMLElement;
    style: HTMLStyleElement;
    mime: string;
    value: any;
    context: RendererContext<unknown>;
}
type messageType = 'info' | 'success' | 'error';

// This function is called to render your contents.
export function render({ container, feedback, mime, value, style, console: consoleElement }: IRenderInfo) {
    const { language, source, addons } = value;

    function addFeedback(message: string, category: messageType = 'info') {
        const el = document.createElement('div');
        el.classList.add(category);

        el.innerText = message;
        feedback.append(el);
    }
    function addConsoleMessage(objects: ConsoleObjectView[], category: messageType = 'info') {
        const el = document.createElement('div');
        el.classList.add(category, 'console-message');
        for(const obj of objects) {
            const view = obj.getElement();
            el.append(view);
        }
        consoleElement.append(el);
    }

    if(language === 'html') {
        container.innerHTML = source;

        for(const {type, content} of addons) {
            if(type === 'test' || type === 'javascript' || type === 'js') {
                eval(content);
            } else if(type === 'css') {
                style.textContent += '\n\n' + content;
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
    } else if(language === 'css') {
        for(const {type, content} of addons) {
            if(type === 'html') {
                container.innerHTML = content;
            } else if(type === 'css') {
                style.textContent += '\n\n' + content;
            } else if(type === 'test' || type === 'javascript' || type === 'js') {
                eval(content);
            }
        }
        /*
        const ast = css.parse(source);
        
        let numSelectors: number = 0;
        let numRules: number = 0;
        if(ast.stylesheet) {
            numSelectors = ast.stylesheet.rules.length;
            for (const rule of ast.stylesheet.rules) {
                if (rule.type === 'rule') {
                    if(rule.selectors) {
                        numRules += rule.selectors.length;
                    }
                }
            }
        }

        container.innerText = `CSS with ${numRules} rules`;
        */
    } else if (language === 'javascript' || language === 'js') {
        for(const {type, content} of addons) {
            if(type === 'html') {
                container.innerHTML = content;
            } else if(type === 'css') {
                style.textContent += '\n\n' + content;
            // } else if(type === 'test' || type === 'javascript' || type === 'js') {
            //     eval(content);
            }
        }
        const oldConsole = window.console;
        const console = {
            doLog: (method: "log"|"trace"|"error", ...args: any[]) => {
                let cls: messageType = "info";
                if (method === 'log' || method === 'trace') { cls = "info"; }
                else if (method === 'error') { cls = "error"; }

                addConsoleMessage(args.map(a => new ConsoleObjectView(a)), cls);
                oldConsole.log(...args);
            },
            log: (...args: any[]) => {
                console.doLog('log', ...args);
            },
            error: (...args: any[]) => {
                console.doLog('error', ...args);
            },
            trace: (...args: any[]) => {
                console.doLog('trace', ...args);
            }
        };
        const document = container;
        (document as any).body = container;
        const sy = cy;
        function wrap(object: any, passMessage: string, failMessage: string) {
            return cy.wrap(object, (passed: boolean, message: string, trace: string[]) => {
                if(passed) {
                    addFeedback(`${message}`, 'success');
                } else {
                    addFeedback(`${message}`, 'error');
                }
            });
        }
        try {
            let toEval = source;
            for(const {type, content} of addons) {
                if(type === 'test' || type === 'javascript' || type === 'js') {
                    toEval += '\n\n' + content;
                }
            }
            window.console.log(toEval);
            eval(toEval);
        } catch (error) {
            addFeedback(`Error in JavaScript code: ${error}`, 'error');
        }
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
