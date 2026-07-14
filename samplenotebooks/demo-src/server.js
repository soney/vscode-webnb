// A tiny HTTP "notes" API used by walkthrough.webnb to demonstrate
// code walkthrough cells. It is here to be read, not run.

// #region setup
const http = require('http');
const { readBody, sendJson } = require('./utils');

const PORT = process.env.PORT || 3000;
const notes = new Map();
let nextId = 1;
// #endregion

// #region routes
async function handleRequest(request, response) {
    if (request.method === 'GET' && request.url === '/notes') {
        return sendJson(response, 200, Array.from(notes.values()));
    }

    if (request.method === 'POST' && request.url === '/notes') {
        const body = await readBody(request);
        const note = { id: nextId++, text: body.text };
        notes.set(note.id, note);
        return sendJson(response, 201, note);
    }

    sendJson(response, 404, { error: 'Not found' });
}
// #endregion

// #region startup
const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
        sendJson(response, 500, { error: error.message });
    });
});

server.listen(PORT, () => {
    console.log(`Notes API listening on port ${PORT}`);
});
// #endregion
