/*
	Portions of this file are derived from Cline (https://github.com/cline/cline)
	v3.8.4, file: src/integrations/terminal/TerminalManager.ts

	Original Work License: Apache License, Version 2.0
	You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

	Modifications for Relief Pilot (VS Code extension) by Ivan Mezentsev, 2025.

	SPDX-License-Identifier: Apache-2.0
*/
import * as vscode from "vscode"
import { arePathsEqual } from "../../utils/path"
import { mergePromise, primeExecutionStream, TerminalProcess, TerminalProcessResultPromise } from "./TerminalProcess"
import { TerminalInfo, TerminalRegistry } from "./TerminalRegistry"

/*
TerminalManager:
- Creates/reuses terminals
- Runs commands via runCommand(), returning a TerminalProcess
- Handles shell integration events

TerminalProcess extends EventEmitter and implements Promise:
- Emits 'line' events with output while promise is pending
- process.continue() resolves promise and stops event emission
- Allows real-time output handling or background execution

getUnretrievedOutput() fetches latest output for ongoing commands

Enables flexible command execution:
- Await for completion
- Listen to real-time events
- Continue execution in background
- Retrieve missed output later

Notes:
- it turns out some shellIntegration APIs are available on cursor, although not on older versions of vscode
- "By default, the shell integration script should automatically activate on supported shells launched from VS Code."
Supported shells:
Linux/macOS: bash, fish, pwsh, zsh
Windows: pwsh


Example:

const terminalManager = new TerminalManager(context);

// Run a command
const process = terminalManager.runCommand('npm install', '/path/to/project');

process.on('line', (line) => {
		console.log(line);
});

// To wait for the process to complete naturally:
await process;

// Or to continue execution even if the command is still running:
process.continue();

// Later, if you need to get the unretrieved output:
const unretrievedOutput = terminalManager.getUnretrievedOutput(terminalId);
console.log('Unretrieved output:', unretrievedOutput);

Resources:
- https://github.com/microsoft/vscode/issues/226655
- https://code.visualstudio.com/updates/v1_93#_terminal-shell-integration-api
- https://code.visualstudio.com/docs/terminal/shell-integration
- https://code.visualstudio.com/api/references/vscode-api#Terminal
- https://github.com/microsoft/vscode-extension-samples/blob/main/terminal-sample/src/extension.ts
- https://github.com/microsoft/vscode-extension-samples/blob/main/shell-integration-sample/src/extension.ts
*/

/*
The new shellIntegration API gives us access to terminal command execution output handling.
However, we don't update our VSCode type definitions or engine requirements to maintain compatibility
with older VSCode versions. Users on older versions will automatically fall back to using sendText
for terminal command execution.
Interestingly, some environments like Cursor enable these APIs even without the latest VSCode engine.
This approach allows us to leverage advanced features when available while ensuring broad compatibility.
*/
declare module "vscode" {
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L10794
	interface Window {
		onDidStartTerminalShellExecution?: (
			listener: (e: any) => any,
			thisArgs?: any,
			disposables?: vscode.Disposable[],
		) => vscode.Disposable
	}
}

export class TerminalManager {
	private static instance: TerminalManager | null = null
	private terminalIds: Set<number> = new Set()
	private processes: Map<number, TerminalProcess> = new Map()
	private disposables: vscode.Disposable[] = []

	private constructor() {
		// Prime the execution stream as early as possible to avoid missing initial bytes.
		// This intentionally does not consume the stream; it only ensures `read()` is called
		// once per execution and cached for the command-specific consumer.
		let disposable: vscode.Disposable | undefined
		try {
			disposable = (vscode.window as vscode.Window).onDidStartTerminalShellExecution?.((e: any) => {
				if (e?.execution) {
					primeExecutionStream(e.execution)
				}
			})
		} catch {
			// Ignore
		}
		if (disposable) {
			this.disposables.push(disposable)
		}

		this.disposables.push(
			vscode.window.onDidCloseTerminal((terminal) => {
				try {
					const terminalInfo = TerminalRegistry.getTerminalByInstance(terminal)
					if (terminalInfo) {
						const process = this.processes.get(terminalInfo.id)
						if (process) {
							process.emit("continue")
						}
						this.terminalIds.delete(terminalInfo.id)
						this.processes.delete(terminalInfo.id)
						TerminalRegistry.removeTerminal(terminalInfo.id)
					}
				} catch (error) {
					console.error("Error handling terminal closure:", error)
				}
			}),
		)
	}

	static getInstance(): TerminalManager {
		if (!TerminalManager.instance) {
			TerminalManager.instance = new TerminalManager()
		}
		return TerminalManager.instance
	}

	runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise {
		const isFirstCommandInTerminal = terminalInfo.lastCommand === ""
		terminalInfo.busy = true
		terminalInfo.lastCommand = command
		const process = new TerminalProcess()
		process.newTerminal = isFirstCommandInTerminal
		this.processes.set(terminalInfo.id, process)

		process.once("completed", () => {
			terminalInfo.busy = false
		})
		process.once("error", () => {
			terminalInfo.busy = false
		})

		// if shell integration is not available, remove terminal so it does not get reused as it may be running a long-running process
		process.once("no_shell_integration", () => {
			console.log(`no_shell_integration received for terminal ${terminalInfo.id}`)
			// Remove the terminal so we can't reuse it (in case it's running a long-running process)
			TerminalRegistry.removeTerminal(terminalInfo.id)
			this.terminalIds.delete(terminalInfo.id)
			this.processes.delete(terminalInfo.id)
		})

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => {
				resolve()
			})
			process.once("error", (error) => {
				console.error(`Error in terminal ${terminalInfo.id}:`, error)
				reject(error)
			})
		})

		console.log(`Running command in terminal ${terminalInfo.id} via sendText:`, command)
		process.run(terminalInfo.terminal, command)

		return mergePromise(process, promise)
	}

	async getOrCreateTerminal(cwd: string, options?: { forceNew?: boolean }): Promise<TerminalInfo> {
		const terminals = TerminalRegistry.getAllTerminals()

		// Force a fresh terminal regardless of existing idle terminals.
		if (options?.forceNew) {
			const newTerminalInfo = TerminalRegistry.createTerminal(cwd)
			this.terminalIds.add(newTerminalInfo.id)
			return newTerminalInfo
		}

		// Find available terminal from our pool first (created for this task)
		const matchingTerminal = terminals.find((t) => {
			if (t.busy) {
				return false
			}
			const terminalCwd = t.terminal.shellIntegration?.cwd // one of cline's commands could have changed the cwd of the terminal
			if (!terminalCwd) {
				return false
			}
			return arePathsEqual(vscode.Uri.file(cwd).fsPath, terminalCwd.fsPath)
		})
		if (matchingTerminal) {
			this.terminalIds.add(matchingTerminal.id)
			return matchingTerminal
		}

		// If no matching terminal exists, try to find any non-busy terminal
		const availableTerminal = terminals.find((t) => !t.busy)
		if (availableTerminal) {
			// Navigate back to the desired directory
			await this.runCommand(availableTerminal, `cd "${cwd}"`)
			this.terminalIds.add(availableTerminal.id)
			return availableTerminal
		}

		// If all terminals are busy, create a new one
		const newTerminalInfo = TerminalRegistry.createTerminal(cwd)
		this.terminalIds.add(newTerminalInfo.id)
		return newTerminalInfo
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return Array.from(this.terminalIds)
			.map((id) => TerminalRegistry.getTerminal(id))
			.filter((t): t is TerminalInfo => t !== undefined && t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

	disposeAll() {
		// for (const info of this.terminals) {
		// 	//info.terminal.dispose() // dont want to dispose terminals when task is aborted
		// }
		this.terminalIds.clear()
		this.processes.clear()
		this.disposables.forEach((disposable) => disposable.dispose())
		this.disposables = []
		TerminalManager.instance = null
	}
}
