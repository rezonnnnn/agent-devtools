// Serves the fixture page; prints its URL on stdout once listening. Runs as
// its own process because the tests drive the CLI synchronously.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/api/data') {
    res.setHeader('content-type', 'application/json');
    res.end('{"v":42}');
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  }
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/`);
});
