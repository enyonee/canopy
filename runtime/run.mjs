#!/usr/bin/env node
// run.mjs <graph.json> [--port 8901] [--db file] [--trace file] [--check]
//        run.mjs --import-openapi spec.json --name NAME [--out FILE]
//        run.mjs <graph.json> --connectors status|live NAME --confirm|sandbox NAME | --secrets set NAME|list|rm NAME
import { main } from './cli.mjs';
// A secret's value is read here, from stdin, when a command asks for it: never from the arguments.
const stdin = async () => { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };
const { code, app } = await main(process.argv.slice(2), { stdin });
if (!app) process.exit(code);
