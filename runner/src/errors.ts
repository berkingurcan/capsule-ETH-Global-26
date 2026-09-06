/**
 * Turning viem's errors into log lines.
 *
 * Lives on its own so both the config loader and the halt path can use it
 * without importing each other.
 */
import { BaseError, ContractFunctionRevertedError } from "viem";

/**
 * viem's revert messages run to thirty lines, which is right for a stack trace
 * and wrong for a log stream a dashboard renders. Reduce to the error name.
 */
export function shortRevert(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}
