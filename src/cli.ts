/**
 * vexplor-edge — the remote collector.
 *
 *     vexplor-edge register --config edge.json --code 7KQ4-M2XD-9PRT   # once, with the code a person made on the server
 *     vexplor-edge run --config edge.json                              # the service runs this
 *     vexplor-edge --version
 *
 * Logs one JSON object per line on stdout (time, level, message) — a service manager or log shipper reads them as is.
 * SIGINT / SIGTERM (Windows: Ctrl+C / Ctrl+Break) close the readers and exit; nothing else can stop it (there is no
 * remote stop).
 */
import { EdgeAgent } from './agent.js';
import { loadCredentials, loadEdgeConfig } from './config.js';
import { EDGE_VERSION } from './version.js';

function log(level: 'info' | 'error', message: string): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message })}\n`);
}

function argument(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (command === '--version' || command === 'version') {
    process.stdout.write(`vexplor-edge ${EDGE_VERSION}\n`);
    return 0;
  }
  const configFile = argument(args, 'config');
  if ((command !== 'register' && command !== 'run') || !configFile) {
    log('error', 'usage: vexplor-edge register --config <file> --code <code> | vexplor-edge run --config <file>');
    return 2;
  }
  const config = loadEdgeConfig(configFile);
  const agent = new EdgeAgent({ config, credentials: loadCredentials(config.credentialsFile), log: (line) => log('info', line) });
  if (command === 'register') {
    const code = argument(args, 'code');
    if (!code) {
      log('error', '--code is required');
      return 2;
    }
    const identity = await agent.register(code);
    const state = await agent.approvalState();
    log(
      'info',
      state === 'approved'
        ? `registered as ${identity.deviceId} — its read list is already approved; it reads as soon as the service starts`
        : `registered as ${identity.deviceId} — approve its read list on the server's 「원격 수집기」 screen; until then it reads nothing`,
    );
    return 0;
  }
  await agent.start();
  log('info', `running as ${agent.identity.deviceId}, boot ${agent.bootId}`);
  await new Promise<void>((resolve) => {
    const end = (): void => resolve();
    process.once('SIGINT', end);
    process.once('SIGTERM', end);
    // Windows has no SIGTERM: the service wrapper (WinSW) stops the program with Ctrl+C (SIGINT); Ctrl+Break is SIGBREAK
    if (process.platform === 'win32') process.once('SIGBREAK', end);
  });
  await agent.stop();
  return 0;
}
