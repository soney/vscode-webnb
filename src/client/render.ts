// We've set up this sample using CSS modules, which lets you import class
// names into JavaScript: https://github.com/css-modules/css-modules
// You can configure or change this in the webpack.config.js file.
// import * as style from './style.css';
import type { RendererContext } from 'vscode-notebook-renderer';
import cy from './lite-cy';
import { marked } from 'marked';
import ConsoleObjectView from './consoleobjectview';
// import * as css from "css";

interface IRenderInfo {
    container: HTMLElement;
    feedback: HTMLElement;
    console: HTMLElement;
    style: HTMLStyleElement;
    addStyle: (css: string) => void;
    mime: string;
    value: any;
    context: RendererContext<unknown>;
}
type messageType = 'info' | 'success' | 'error';
interface McqOption {
    text: string;
    correct: boolean;
    correctFeedback?: string;
    wrongFeedback?: string;
}
interface ParsedMcq {
    question: string;
    options: McqOption[];
    correctFeedback?: string;
    wrongFeedback?: string;
}

function parseMcqSource(source: string): ParsedMcq {
    const lines = source.split(/\r?\n/);
    const options: McqOption[] = [];
    const questionLines: string[] = [];
    let correctFeedback: string | undefined;
    let wrongFeedback: string | undefined;
    let sawOption = false;
    let currentOption: McqOption | undefined;

    for (const line of lines) {
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
        question: questionLines.join('\n').trim(),
        options,
        correctFeedback,
        wrongFeedback
    };
}

// This function is called to render your contents.
export function render({ container, feedback, mime, value, style, addStyle, console: consoleElement }: IRenderInfo) {
    const { language, source, addons } = value;

    function addFeedback(message: string, category: messageType = 'info', isHtml: boolean = false) {
        feedback.innerHTML = '';
        const el = document.createElement('div');
        el.classList.add(category);

        if (isHtml) {
            el.innerHTML = message;
        } else {
            el.innerText = message;
        }
        feedback.append(el);
    }
    function addConsoleMessage(objects: ConsoleObjectView[], category: messageType = 'info') {
        const el = document.createElement('div');
        el.classList.add(category, 'console-message');
        for (const obj of objects) {
            const view = obj.getElement();
            el.append(view);
        }
        consoleElement.append(el);
    }

    function assert(selector: string, passMessage: string, failMessage: string) {
        return cy(container, (passed: boolean, message: string, trace: string[]) => {
            if (passed) {
                addFeedback(`${message}`, 'success');
            } else {
                addFeedback(`${message}`, 'error');
            }
        }).get(selector);
    }

    function assertRule(selector: string) {
        return cy.getRule(selector, (passed: boolean, message: string, trace: string[]) => {
            if (passed) {
                addFeedback(`${message}`, 'success');
            } else {
                addFeedback(`${message}`, 'error');
            }
        });
    }

    if (language === 'html') {
        container.innerHTML = source;

        for (const { type, content } of addons) {
            if (type === 'test' || type === 'javascript' || type === 'js') {
                eval(content);
            } else if (type === 'css') {
                addStyle(content);
            }

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
    } else if (language === 'css') {
        addStyle(source);
        for (const { type, content } of addons) {
            if (type === 'html') {
                container.innerHTML = content;
            } else if (type === 'css') {
                addStyle(content);
            } else if (type === 'test' || type === 'javascript' || type === 'js') {
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
    } else if (language === 'mcq') {
        const { question, options, correctFeedback, wrongFeedback } = parseMcqSource(source);
        if (!question || options.length === 0) {
            addFeedback('MCQ cells need a question plus at least one option.', 'error');
            return;
        }

        const numCorrect = options.filter(o => o.correct).length;
        const inputType = numCorrect > 1 ? 'checkbox' : 'radio';

        const form = document.createElement('form');
        form.classList.add('mcq-form');

        const questionEl = document.createElement('div');
        questionEl.classList.add('mcq-question');
        questionEl.innerHTML = marked.parse(question) as string;
        form.appendChild(questionEl);

        const optionFeedbackEls: HTMLDivElement[] = [];

        options.forEach((opt, index) => {
            const optionRow = document.createElement('div');
            optionRow.classList.add('mcq-option-row');

            const label = document.createElement('label');
            label.classList.add('mcq-option');

            const input = document.createElement('input');
            input.type = inputType;
            input.name = 'mcq-option';
            input.value = index.toString();

            label.appendChild(input);
            const span = document.createElement('span');
            span.innerHTML = marked.parseInline(opt.text) as string;
            label.appendChild(span);

            const optionFeedbackEl = document.createElement('div');
            optionFeedbackEl.classList.add('mcq-option-feedback');
            optionFeedbackEl.hidden = true;

            optionFeedbackEls.push(optionFeedbackEl);
            optionRow.append(label, optionFeedbackEl);
            form.appendChild(optionRow);
        });

        const checkBtn = document.createElement('button');
        checkBtn.textContent = 'Check Answer';
        checkBtn.type = 'button';
        checkBtn.classList.add('mcq-check-button');

        checkBtn.addEventListener('click', () => {
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

            inputs.forEach((input, index) => {
                const opt = options[index];
                const itemIsCorrect = input.checked === opt.correct;
                if (!itemIsCorrect) {
                    allCorrect = false;
                }

                const itemFeedback = itemIsCorrect ? opt.correctFeedback : opt.wrongFeedback;
                if (itemFeedback) {
                    const optionFeedbackEl = optionFeedbackEls[index];
                    optionFeedbackEl.hidden = false;
                    optionFeedbackEl.classList.add(itemIsCorrect ? 'success' : 'error');
                    optionFeedbackEl.innerHTML = marked.parseInline(itemFeedback) as string;
                }
            });

            if (allCorrect) {
                addFeedback(marked.parseInline(correctFeedback || 'Correct!') as string, 'success', true);
            } else {
                addFeedback(marked.parseInline(wrongFeedback || 'Incorrect. Try again.') as string, 'error', true);
            }
        });

        form.appendChild(checkBtn);
        container.appendChild(form);

    } else if (language === 'javascript' || language === 'js') {
        for (const { type, content } of addons) {
            if (type === 'html') {
                container.innerHTML = content;
            } else if (type === 'css') {
                addStyle(content);
                // } else if(type === 'test' || type === 'javascript' || type === 'js') {
                //     eval(content);
            }
        }
        const oldConsole = window.console;
        const console = {
            doLog: (method: "log" | "trace" | "error", ...args: any[]) => {
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
                if (passed) {
                    addFeedback(`${message}`, 'success');
                } else {
                    addFeedback(`${message}`, 'error');
                }
            });
        }
        try {
            let toEval = source;
            for (const { type, content } of addons) {
                if (type === 'test' || type === 'javascript' || type === 'js') {
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
