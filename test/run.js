#!/usr/bin/env node
// Test entry point: syntax-check every JS file, then run each *.test.js in a
// fresh Node process (each gets its own temp database).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dirs = ['electron', 'renderer/js', 'test'];
let failed = 0;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => walk(path.join(root, d))).sort();
console.log(`Syntax check: ${files.length} files`);
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.log(`  FAIL ${path.relative(root, file)}`);
    console.log(r.stderr.trim());
  }
}
if (failed) {
  console.log(`\n${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log('  ok all files parse');

const tests = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

console.log(`\nRunning ${tests.length} test files`);
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) failed += 1;
}

if (failed) {
  console.log(`\nFAILED: ${failed} test file(s)`);
  process.exit(1);
}
console.log(`\nPASS — ${tests.length} test files`);
