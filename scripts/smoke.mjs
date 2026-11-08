const services = [
  ["api", process.env.SMOKE_API_BASE ?? "http://127.0.0.1:4100"],
  ["gateway", process.env.SMOKE_GATEWAY_BASE ?? "http://127.0.0.1:4101"],
  ["worker", process.env.SMOKE_WORKER_BASE ?? "http://127.0.0.1:4102"],
];

let failed = false;
for (const [name, base] of services) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3_000) });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(`http=${res.status} ${JSON.stringify(body)}`);
    console.log(`ok  ${name} ${base}`);
  } catch (err) {
    failed = true;
    console.error(`bad ${name} ${base}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  const res = await fetch(`${services[1][1]}/metrics`, { signal: AbortSignal.timeout(3_000) });
  const text = await res.text();
  if (!/xiaoqi_poll_up\{[^}]*\}\s+1/.test(text)) throw new Error("xiaoqi_poll_up is not 1");
  console.log("ok  ilink poll_up=1");
} catch (err) {
  failed = true;
  console.error(`bad ilink poller: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed) process.exit(1);
console.log("smoke ok");
