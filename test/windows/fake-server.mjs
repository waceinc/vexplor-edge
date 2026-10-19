/**
 * A stand-in server for the Windows service smoke test (service-smoke.ps1) — just enough of contract vexplor.edge/1 for
 * the installed service to register, read an approved empty read list and send its heartbeat batch. It checks no
 * signature: the real server's checks run in the interop tests. It counts what it was asked, at GET /_seen.
 *
 *     node test/windows/fake-server.mjs <file to write the port to>
 */
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const seen = { register: 0, readList: 0, batches: 0, samples: 0 };

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const answer = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', date: new Date().toUTCString() });
      response.end(JSON.stringify(body));
    };
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'POST' && path === '/edge/v1/register') {
      seen.register += 1;
      return answer(201, { deviceId: 'dev_windows_ci', registeredAt: new Date().toISOString() });
    }
    if (request.method === 'GET' && path === '/edge/v1/read-list') {
      seen.readList += 1;
      return answer(200, { revision: 'r1', state: 'approved', pollSeconds: 2, interfaces: [] });
    }
    if (request.method === 'POST' && path === '/edge/v1/batches') {
      seen.batches += 1;
      seen.samples += JSON.parse(Buffer.concat(chunks).toString('utf8')).samples?.length ?? 0;
      return answer(202, { accepted: 0, rejected: [] });
    }
    if (request.method === 'GET' && path === '/_seen') return answer(200, seen);
    return answer(404, { code: 'NotFound' });
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.argv[2], String(server.address().port));
});
