#!/usr/bin/env node
// Edits are patches over node paths, not rewrites of the document.
// usage: patch.mjs <graph.json> <patch.json>   (RFC 6902 subset: add, replace, remove)
import fs from 'node:fs';
import { validate, formatErrors } from './validate.mjs';

const seg = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const walk = (root, path) => {
  const parts = path.split('/').slice(1).map(seg);
  const last = parts.pop();
  let node = root;
  for (const p of parts) {
    if (node[p] === undefined) throw new Error(`path ${path}: "${p}" does not exist`);
    node = node[p];
  }
  return { node, last };
};

export function applyPatch(graph, ops) {
  for (const op of ops) {
    const { node, last } = walk(graph, op.path);
    if (op.op === 'remove') Array.isArray(node) ? node.splice(Number(last), 1) : delete node[last];
    else if (last === '-' && Array.isArray(node)) node.push(op.value);
    else if (Array.isArray(node)) node.splice(Number(last), op.op === 'replace' ? 1 : 0, op.value);
    else node[last] = op.value;
  }
  return graph;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [graphFile, patchFile] = process.argv.slice(2);
  const graph = applyPatch(
    JSON.parse(fs.readFileSync(graphFile, 'utf8')),
    JSON.parse(fs.readFileSync(patchFile, 'utf8')));
  const errors = validate(graph);
  if (errors.length) { console.error(`patch rejected:\n${formatErrors(errors)}`); process.exit(1); }
  fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2) + '\n');
  console.log(`✓ patch applied to ${graphFile}, graph still valid`);
}
