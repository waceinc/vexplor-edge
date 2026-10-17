/**
 * The interop tests run the collector against a real VEXPLOR AAS Studio server from a checkout of
 * github.com/waceinc/vexplor-aas (AAS_DIR, default ../vexplor-aas) — its server code, its test OPC UA server and its
 * fixtures. vitest.interop.config.ts maps the @aas packages to that checkout.
 */
import { join, resolve } from 'node:path';

export const AAS_DIR = resolve(process.env['AAS_DIR'] ?? '../vexplor-aas');
export const aasFixture = (name: string): string => join(AAS_DIR, 'tests/fixtures', name);
