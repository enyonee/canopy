#!/usr/bin/env node
// run.mjs <graph.json> [--port 8901] [--db file] [--trace file] [--check]
import { main } from './cli.mjs';
const { code, app } = main(process.argv.slice(2));
if (!app) process.exit(code);
