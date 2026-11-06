#!/usr/bin/env node
/** Fake DSH CLI for runner tests. */
const prompt = process.argv.slice(2).join(" ");
console.log(`Fake DSH completed: ${prompt}`);
