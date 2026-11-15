/**
 * The OPC UA server pack.mjs reads from when it checks the bundled collector — node-opcua from node_modules, not from
 * the bundle. Prints "ready <port>" once it listens.
 */
import { OPCUAServer } from 'node-opcua';

const server = new OPCUAServer({ port: Number(process.argv[2]) });
await server.initialize();
await server.start();
process.stdout.write(`ready ${server.endpoints[0].port}\n`);
process.on('SIGTERM', () => {
  server.shutdown(0).then(() => process.exit(0), () => process.exit(1));
});
