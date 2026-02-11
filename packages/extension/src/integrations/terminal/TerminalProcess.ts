/*
	Portions of this file are derived from Cline (https://github.com/cline/cline)
	v3.8.4, file: src/integrations/terminal/TerminalProcess.ts

	Original Work License: Apache License, Version 2.0
	You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

	Modifications for Relief Pilot (VS Code extension) by Ivan Mezentsev, 2025.

	SPDX-License-Identifier: Apache-2.0
*/

import { EventEmitter } from "events"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import { stripAnsi } from "./ansiUtils.js"

const executionStreamCache = new WeakMap<any, AsyncIterable<string>>()

function getOrCreateExecutionStream(execution: any): AsyncIterable<string> {
	const cached = executionStreamCache.get(execution)
	if (cached) {
		return cached
	}
	const stream: AsyncIterable<string> = execution.read()
	executionStreamCache.set(execution, stream)
	return stream
}

/**
 * Prime the execution stream as early as possible to avoid missing initial bytes.
 * This should be called from a global `onDidStartTerminalShellExecution` listener.
 */
export function primeExecutionStream(execution: any): void {
	try {
		getOrCreateExecutionStream(execution)
	} catch {
		// Ignore priming errors; the command-specific path will handle failures.
	}
}

export interface TerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: []
	error: [error: Error]
	no_shell_integration: []
}

export class TerminalProcess extends EventEmitter<TerminalProcessEvents> {
	/**
	 * Set to true by TerminalManager when the terminal was freshly created and
	 * is about to receive its first command. In that case sendText-based paths
	 * must add a brief delay to let the shell finish initialising
	 * readline mode (raw mode) before sending text; otherwise the PTY driver
	 * echoes characters in cooked mode, causing duplicate output.
	 */
	newTerminal: boolean = false
	private isListening: boolean = true
	private buffer: string = ""

	async run(terminal: vscode.Terminal, command: string) {
		const streamOrNull = await this.runViaSendText(terminal, command)
		if (!streamOrNull) {
			// sendText was already called inside runViaSendText; stream tracking
			// is not available (no shell integration events or timed out).
			this.emit("completed")
			this.emit("continue")
			this.emit("no_shell_integration")
			return
		}

		try {
			await this.consumeStream(streamOrNull, command)
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)))
			return
		}
		this.emitRemainingBufferIfListening()
		this.emit("completed")
		this.emit("continue")
	}

	private async consumeStream(stream: AsyncIterable<string>, command: string) {
		let didOutputNonCommand = false
		const expectedCommand = command.trim()
		const commandLines = new Set(
			expectedCommand.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
		)
		const commandLineList = [...commandLines]

		for await (let data of stream) {
			// Remove ANSI/OSC escape sequences (including VS Code shell integration sequences)
			data = stripAnsi(data)

			// The first chunks can include the echoed command line (prompt + command)
			// which is not useful as "output". Remove it conservatively so commands like
			// `echo hello` still work.
			if (!didOutputNonCommand && expectedCommand) {
				const lines = data.split("\n")
				for (let i = 0; i < lines.length; i++) {
					const rawLine = lines[i]
					const cleaned = rawLine.replace(/^[\x00-\x1F]+/g, "").trim()

					let isEchoedCommand = commandLines.has(cleaned)
					if (!isEchoedCommand) {
						for (const commandLine of commandLineList) {
							if (!commandLine) {
								continue
							}
							if (!cleaned.endsWith(commandLine)) {
								continue
							}
							const prefix = cleaned.slice(0, cleaned.length - commandLine.length).trimEnd()
							const lastChar = prefix.length > 0 ? prefix[prefix.length - 1] : ""
							if (lastChar && "%$#>".includes(lastChar)) {
								isEchoedCommand = true
								break
							}
						}
					}

					if (isEchoedCommand) {
						lines.splice(i, 1)
						i--
						continue
					}

					if (cleaned.length > 0) {
						didOutputNonCommand = true
						break
					}
				}
				data = lines.join("\n")
			}

			if (this.isListening) {
				this.emitIfEol(data)
			}
		}
	}

	/**
	 * Send a command to the terminal via sendText and obtain the execution output
	 * stream through the onDidStartTerminalShellExecution event.
	 *
	 * The shell handles continuation prompts naturally when text is sent directly,
	 * and the shell integration events still fire correctly for completion tracking.
	 *
	 * @returns The async iterable stream from the execution, or null if the shell
	 *          integration start event is unavailable or does not fire in time.
	 */
	private async runViaSendText(
		terminal: vscode.Terminal,
		command: string,
	): Promise<AsyncIterable<string> | null> {
		const onStart = (
			vscode.window as vscode.Window
		).onDidStartTerminalShellExecution

		if (!onStart) {
			// Event API not available (older VS Code); fall back to plain sendText.
			terminal.sendText(command, true)
			return null
		}

		// For freshly created terminals the shell may not yet be in readline
		// mode (raw mode) when this method is called. Shell integration reports
		// itself as available after detecting OSC 633 markers, but the
		// shell's line editor typically activates slightly later. Sending text
		// while the PTY is still in cooked mode causes the terminal driver to
		// echo the characters, resulting in duplicate output.
		//
		// We first ensure CWD is detected (happens in precmd, right before the
		// prompt) and then add a fixed delay to let readline finish activating.
		// The flag is set by TerminalManager for freshly created terminals.
		// Existing terminals already have readline active and skip the delay entirely.
		if (this.newTerminal) {
			try {
				// Important: shellIntegration may not be defined yet in a brand new terminal.
				// Waiting on cwd (reported from precmd) ensures the prompt is about to render.
				await pWaitFor(() => !!terminal.shellIntegration?.cwd, {
					timeout: 2000,
					interval: 50,
				})
			} catch {
				// Timed out; proceed anyway.
			}
			// CWD is reported from precmd which runs before the prompt is drawn
			// and before readline enters raw mode. A brief delay bridges this gap.
			await new Promise(resolve => setTimeout(resolve, 300))
		}

		return new Promise<AsyncIterable<string> | null>((resolve) => {
			let settled = false

			let disposable: vscode.Disposable | undefined
			try {
				disposable = onStart((e: any) => {
					try {
						if (!settled && e?.terminal === terminal && e?.execution) {
							settled = true
							disposable?.dispose()
							clearTimeout(timer)
							resolve(getOrCreateExecutionStream(e.execution))
						}
					} catch (err) {
						console.error('runViaSendText: error in start listener', err)
						if (!settled) {
							settled = true
							disposable?.dispose()
							clearTimeout(timer)
							resolve(null)
						}
					}
				})
			} catch (err) {
				console.error('runViaSendText: failed to subscribe to shell execution start', err)
				terminal.sendText(command, true)
				resolve(null)
				return
			}

			// Safety net: if the shell integration does not report execution start
			// within 15 seconds, give up on stream tracking. The command has already
			// been sent and may still be running; the caller will emit the appropriate
			// fallback events.
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true
					disposable?.dispose()
					resolve(null)
				}
			}, 15_000)

			terminal.sendText(command, true)
		})
	}

	// Inspired by https://github.com/sindresorhus/execa/blob/main/lib/transform/split.js
	private emitIfEol(chunk: string) {
		this.buffer += chunk
		let lineEndIndex: number
		while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
			let line = this.buffer.slice(0, lineEndIndex).trimEnd() // removes trailing \r
			// Remove \r if present (for Windows-style line endings)
			// if (line.endsWith("\r")) {
			// 	line = line.slice(0, -1)
			// }
			this.emit("line", line)
			this.buffer = this.buffer.slice(lineEndIndex + 1)
		}
	}

	private emitRemainingBufferIfListening() {
		if (this.buffer && this.isListening) {
			const remainingBuffer = this.removeLastLineArtifacts(this.buffer)
			if (remainingBuffer) {
				this.emit("line", remainingBuffer)
			}
			this.buffer = ""
		}
	}

	/**
	 * @deprecated Kept for compatibility/future long-running command handling.
	 */
	continue() {
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	// some processing to remove artifacts like '%' at the end of the buffer (it seems that since vsode uses % at the beginning of newlines in terminal, it makes its way into the stream)
	// This modification will remove '%', '$', '#', or '>' followed by optional whitespace
	removeLastLineArtifacts(output: string) {
		const lines = output.trimEnd().split("\n")
		if (lines.length > 0) {
			const lastLine = lines[lines.length - 1]
			// Remove prompt characters and trailing whitespace from the last line
			lines[lines.length - 1] = lastLine.replace(/[%$#>]\s*$/, "")
		}
		return lines.join("\n").trimEnd()
	}
}

export type TerminalProcessResultPromise = TerminalProcess & Promise<void>

// Similar to execa's ResultPromise, this lets us create a mixin of both a TerminalProcess and a Promise: https://github.com/sindresorhus/execa/blob/main/lib/methods/promise.js
export function mergePromise(process: TerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
	const nativePromisePrototype = (async () => { })().constructor.prototype
	const descriptors = ["then", "catch", "finally"].map(
		(property) => [property, Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)] as const,
	)
	for (const [property, descriptor] of descriptors) {
		if (descriptor) {
			const value = descriptor.value.bind(promise)
			Reflect.defineProperty(process, property, { ...descriptor, value })
		}
	}
	return process as TerminalProcessResultPromise
}
