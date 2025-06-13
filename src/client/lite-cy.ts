/**
 * lite-cypress.ts
 * A minimal, standalone Cypress-like testing utility for the browser, written in TypeScript.
 * No dependencies, ~1KB minified.
 *
 * Usage:
 *   <script src="lite-cypress.js"></script>
 *   <script>
 *     cy.get('h1')
 *       .should('exist')
 *       .should('have.text', 'Heading')
 *       .click();
 *   </script>
 */

type Assertion = 'exist' | 'have.text' | 'have.class' | 'have.attribute';

interface Chainable {
    elements: Element[];
    should(assertion: Assertion, expected?: string): Chainable;
    click(): Chainable;
    type(text: string): Chainable;
    clear(): Chainable;
    find(selector: string): Chainable;
    get(selector: string): Chainable;
    contains(text: string): Chainable;
}

function createChain(elements: Element[]): Chainable {
    const chain: Chainable = {
        elements,

        should(assertion: Assertion, expected?: string): Chainable {
            if(assertion === 'exist' && this.elements.length === 0) {
                throw new Error('Expected at least one element to exist, but found none');
            }
            for (const el of this.elements) {
                if(assertion === 'have.text') {
                    if(el.textContent !== expected) {
                        throw new Error(`Expected text "${expected}", got "${el.textContent}"`);
                    }
                } else if(assertion === 'have.class') {
                    if (!(el instanceof HTMLElement) || !el.classList.contains(expected!)) {
                        throw new Error(`Expected element to have class "${expected}"`);
                    }
                } else if(assertion === 'have.attribute') {
                    if (!(el instanceof HTMLElement) || !el.hasAttribute(expected!)) {
                        throw new Error(`Expected element to have attribute "${expected}"`);
                    }
                }
            }
            return chain;
        },

        click(): Chainable {
            this.elements.forEach(el => {
                if (el instanceof HTMLElement) {
                    el.click();
                }
            });
            return chain;
        },

        type(text: string): Chainable {
        this.elements.forEach(el => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                throw new Error('`type()` can only be called on <input> or <textarea> elements');
            }
        });
        return chain;
        },

        clear(): Chainable {
            this.elements.forEach(el => {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            return chain;
        },

        find(selector: string): Chainable {
            let found: Element[] = [];
            this.elements.forEach(el => {
                found = found.concat(Array.from(el.querySelectorAll(selector)));
            });
            return createChain(found);
        },

        get(selector: string): Chainable {
            return this.find(selector);
        },

        contains(text: string): Chainable {
            const all = Array.from(document.querySelectorAll('*'));
            const found = all.filter(el => el.textContent?.includes(text));
            return createChain(found);
        }
    };
    return chain;
}

/*
declare global {
    interface Window {
        cy: {
            get(selector: string): Chainable;
        };
    }
}
*/

function cy(el: string|Element|Element[]): Chainable {
    if (typeof el === 'string') {
        const nodes = Array.from(document.querySelectorAll(el));
        return createChain(nodes);
    } else if (el instanceof Element) {
        return createChain([el]);
    } else if (Array.isArray(el)) {
        return createChain(el);
    } else {
        throw new Error('Invalid argument: must be a string selector, Element, or array of Elements');
    }
}
cy.get = function (selector: string): Chainable {
    const nodes = Array.from(document.querySelectorAll(selector));
    return createChain(nodes);
};
export default cy;

// export default {
//     get(selector: string) {
//         const nodes = Array.from(document.querySelectorAll(selector));
//         return createChain(nodes);
//     }
// };
