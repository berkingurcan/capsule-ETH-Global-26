/**
 * One account, two writers, one queue.
 *
 * Until now the agent key had exactly one user: the tick loop, writing
 * `agent-heartbeat` on a timer. Nothing could race it. The wallet broker adds a
 * second, driven by a language model on no schedule at all, and the two share
 * an account.
 *
 * viem reads the pending nonce at send time. Two sends that overlap read the
 * same number, and the chain keeps one of them — `nonce too low` or
 * `replacement transaction underpriced`, depending on which lost. In the tick
 * loop that surfaces as a failed heartbeat, which `classifyHeartbeatFailure`
 * correctly calls transient and which nonetheless spends the failure budget and
 * prints a scary line in the middle of a demo.
 *
 * `web/lib/capsule/fund.ts` already documents this exact problem and solves it
 * the same way, for the same reason: a promise chain is enough when there is one
 * process holding the key, and there is. The honest limit is written down there
 * too — this holds within one process and not across a horizontally scaled
 * deployment. A capsule is one container with one key, so within a process is
 * the whole domain.
 *
 * Deliberately not a lock with a timeout. A heartbeat that waits behind a slow
 * agent transaction is a heartbeat that lands late; a heartbeat that gives up
 * waiting and sends anyway is a heartbeat that does not land at all.
 */

export class Serializer {
  /** The tail of the chain. Rejections are absorbed so one failure ends nothing. */
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** How many jobs are queued or running. Reported so a wait can be explained. */
  get depth(): number {
    return this.#depth;
  }

  /**
   * Run `job` after everything already queued, and hand back its result.
   *
   * The caller sees its own job's outcome and nothing else: a job that throws
   * rejects only the promise returned to whoever submitted it, and the queue
   * carries on. Without that, one failed heartbeat would poison every later
   * transaction on the same chain of promises.
   */
  submit<T>(job: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(job, job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#depth -= 1;
    });
  }
}
