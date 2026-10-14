/**
 * LAUNCH-02 · Worker consumer configuration. An optional consumer whose dedicated login is not
 * configured is skipped, and the skip is logged. That suits development, but a production deployment
 * should not silently run without rankings, records or achievements. BR_WORKER_REQUIRED_CONSUMERS
 * (comma-separated) names the consumers that must be enabled; the worker refuses to start otherwise.
 */
export interface WorkerConsumerState {
  readonly name: string;
  readonly enabled: boolean;
  /** Why a disabled consumer is off (operator-facing; names a variable, never a value). */
  readonly disabledReason?: string;
}

export class WorkerConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`worker configuration refused: ${problems.join('; ')}`);
    this.name = 'WorkerConfigError';
    this.problems = problems;
  }
}

/** Throws WorkerConfigError when a required consumer is unknown or disabled. */
export function assertRequiredConsumers(
  states: readonly WorkerConsumerState[],
  required: string | undefined,
): void {
  const names = (required ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  const problems: string[] = [];
  for (const name of names) {
    const state = states.find((s) => s.name === name);
    if (state === undefined)
      problems.push(
        `BR_WORKER_REQUIRED_CONSUMERS names an unknown consumer "${name}" (known: ${states.map((s) => s.name).join(', ')})`,
      );
    else if (!state.enabled)
      problems.push(
        `required consumer ${name} is disabled: ${state.disabledReason ?? 'not configured'}`,
      );
  }
  if (problems.length > 0) throw new WorkerConfigError(problems);
}
