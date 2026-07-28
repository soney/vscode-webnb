/**
 * The feedback pane under a cell's output: where checks, assertions, and
 * errors report to the learner.
 */
import { renderSmartText } from './markdown';

export type messageType = 'info' | 'success' | 'error';

export interface FeedbackWriters {
    /** Adds a message to the feedback pane. */
    appendFeedback: (message: string, category?: messageType, isHtml?: boolean) => void;
    /** Replaces the feedback pane with a single message. */
    addFeedback: (message: string, category?: messageType, isHtml?: boolean) => void;
}

export function createFeedback(feedback: HTMLElement): FeedbackWriters {
    function appendFeedback(message: string, category: messageType = 'info', isHtml: boolean = false) {
        const el = document.createElement('div');
        el.classList.add(category);
        if (isHtml) {
            el.innerHTML = message;
        } else {
            el.innerHTML = renderSmartText(message);
        }
        feedback.append(el);
    }

    function addFeedback(message: string, category: messageType = 'info', isHtml: boolean = false) {
        feedback.innerHTML = '';
        appendFeedback(message, category, isHtml);
    }

    return { appendFeedback, addFeedback };
}
