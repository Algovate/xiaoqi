#!/usr/bin/env node
/** Fake codex CLI for runner tests: emits JSONL and writes -o output. */
import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
let out = "";
let prompt = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-o") out = args[i + 1] ?? "";
  if (args[i] === "-C") i += 1;
  else prompt = args[i] ?? "";
}
console.log(JSON.stringify({ type: "session_configured", session_id: "fake-session" }));
console.log(JSON.stringify({ type: "item.started", item: { text: "working" } }));
console.log(JSON.stringify({ type: "item.completed", item: { text: "done" } }));
if (out) fs.writeFileSync(out, `Fake Codex completed: ${prompt}`);
