import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A flag that follows one article's work through the whole pipeline.
 *
 * The bulk runner needs every model call an article makes to go through the
 * shared batch queue, and those calls are made five layers down: the
 * generator asks the humanize service, which asks the LLM service, which asks
 * a provider. Threading a boolean through all of that would mean touching
 * every signature in between and would leave a permanent "are we batching"
 * parameter in code that has no business caring.
 *
 * AsyncLocalStorage carries it instead. It survives awaits, so an article
 * started inside `runQueued` keeps the flag for its entire lifetime including
 * work that resumes minutes later, and two articles running concurrently each
 * see their own value rather than one global.
 *
 * Deliberately narrow: this says only "this work may be batched". Whether a
 * batch endpoint exists, how big a batch should be and when to send it are
 * all decisions for the queue.
 */
const storage = new AsyncLocalStorage<{ queued: boolean; worker: string }>();

let counter = 0;

/**
 * Run `fn` with every nested model call routed through the batch queue.
 *
 * The worker id lets the queue tell "eight articles each waiting on one call"
 * apart from "one article waiting on forty". Both leave forty requests in the
 * queue, and only the first means everybody has arrived.
 */
export function runQueued<T>(fn: () => Promise<T>): Promise<T> {
  counter += 1;
  return storage.run({ queued: true, worker: `w${counter}` }, fn);
}

/** Which article this call belongs to, or null outside a bulk job. */
export function currentWorker(): string | null {
  const store = storage.getStore();
  return store?.queued ? store.worker : null;
}

/**
 * Run `fn` with batching explicitly OFF, even inside a queued article.
 *
 * Needed for calls that must not wait on a batch: anything on the critical
 * path of deciding whether to keep going, and anything using a model other
 * than the one the queue submits to.
 */
export function runDirect<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ queued: false, worker: 'direct' }, fn);
}

export function isQueued(): boolean {
  return storage.getStore()?.queued === true;
}
