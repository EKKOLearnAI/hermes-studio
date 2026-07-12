export interface ServerMainDependencies {
  bootstrap(): Promise<void>
  stopActionFabricRuntime(): Promise<void>
  reportFatal(error: unknown): void
  reportRollbackFailure(error: unknown): void
  exit(code: number): void
}

/**
 * Runs the process bootstrap without creating import-time lifecycle side effects.
 * The concrete server entry point supplies logging, runtime cleanup and exit.
 */
export async function runServerMain(dependencies: ServerMainDependencies): Promise<void> {
  try {
    await dependencies.bootstrap()
  } catch (error) {
    dependencies.reportFatal(error)
    try {
      await dependencies.stopActionFabricRuntime()
    } catch (rollbackError) {
      dependencies.reportRollbackFailure(rollbackError)
    }
    dependencies.exit(1)
  }
}
