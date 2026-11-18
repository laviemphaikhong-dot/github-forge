// Entry lifecycle for the forge, following the env contract in the kit's wire spec:
// announce the port we bound, then stay alive until the env says the trial is over.
//
//   1. MAKEFUN_ENV_URL names the env's origin. With no env there is nothing to
//      register with, so the process exits 1 immediately.
//   2. The app listens on port 0: the kernel picks a free port. Port 8080 belongs
//      to the env and is never bound here.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N} tells the env where to reach us;
//      it records the caller's address plus N as our base URL. The first register
//      wins: 200 is the normal answer, 409 means another entry registered first and
//      is not ours to fix. 400 and 405 are contract errors and end the program.
//      Any other outcome (network error, timeout, unexpected status) is retried
//      with backoff, because the env may still be starting.
//   4. GET $MAKEFUN_ENV_URL/done is polled until the body is {"done": true}. The
//      env answers at once while the suite runs, so this is a poll loop with the
//      same backoff; the process never exits before the env says done.
//   5. Close the server and exit 0, so the harness can collect the env's export.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may run before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: starts here, doubles per attempt, never exceeds the cap. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `attempt` failed tries: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. Returns on 200 (registered) or 409
 * (a first register already won). Throws on 400/405, which the env only sends for a
 * malformed request; every other failure is retried after a backoff pause.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let refusal: Error | null = null;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        refusal = new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch {
      // A network error or a timed-out request: the env may not be up yet, so retry.
    }
    if (refusal !== null) throw refusal;
    await pause(retryDelay(attempt));
  }
}

/**
 * Poll GET /done until it answers {"done":true}; never return before that.
 * A non-OK status, a body without done set, a network error and a timeout all
 * mean the same thing here: the suite is still running, so wait and poll again.
 */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, poll again.
    }
    await pause(retryDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announce(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
