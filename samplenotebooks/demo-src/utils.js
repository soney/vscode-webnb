// Helpers shared by the demo notes server.

function readBody(request) {
    return new Promise((resolve, reject) => {
        let raw = '';
        request.on('data', chunk => {
            raw += chunk;
        });
        request.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(new Error('Body must be valid JSON'));
            }
        });
        request.on('error', reject);
    });
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

module.exports = { readBody, sendJson };
