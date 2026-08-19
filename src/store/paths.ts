/**
 * State directory resolution for the plugin.
 * @module dsh-ace-harness/store
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** DSH_HOME: shared dsh state root; falls back to ~/.dsh. */
export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Workspace root of the invoking session, or the server process cwd. */
export function workspaceRoot(cwd: string | undefined, fallback: string): string {
  return cwd && cwd.trim() !== '' ? resolve(cwd) : resolve(fallback)
}

/** Project-level workflow instance directory: `<workspace>/.dsh/workflows`. */
export function projectWorkflowsDir(workspace: string): string {
  return join(workspace, '.dsh', 'workflows')
}

/** Personal workflow instance directory: `$DSH_HOME/workflows`. */
export function personalWorkflowsDir(): string {
  return join(dshHome(), 'workflows')
}

/** Run storage root: `<workspace>/<runDirName>/runs`. */
export function runsRoot(workspace: string, runDirName: string): string {
  return join(workspace, runDirName, 'runs')
}

/** One run's directory: `<workspace>/<runDirName>/runs/<runId>`. */
export function runDir(workspace: string, runId: string, runDirName: string): string {
  return join(runsRoot(workspace, runDirName), runId)
}
