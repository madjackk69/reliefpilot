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

export interface TerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: []
	error: [error: Error]
	no_shell_integration: []
}

export class TerminalProcess extends EventEmitter<TerminalProcessEvents> {
	waitForShellIntegration: boolean = true
	/**
	 * Set to true by TerminalManager when the terminal was freshly created and
	 * had to wait for shell integration activation. In that case sendText-based
	 * paths must add a brief delay to let the shell finish initialising
	 * readline mode (raw mode) before sending text; otherwise the PTY driver
	 * echoes characters in cooked mode, causing duplicate output.
	 */
	newTerminal: boolean = false
	private isListening: boolean = true
	private buffer: string = ""

	async run(terminal: vscode.Terminal, command: string) {
		if (terminal.shellIntegration && terminal.shellIntegration.executeCommand) {
			let stream: AsyncIterable<string>

			if (command.includes('\n')) {
				// Multi-line commands cause VS Code's shell integration executeCommand() to
				// hang because its internal multi-line execution tracking
				// (splitAndSanitizeCommandLine / endShellExecution in
				// extHostTerminalShellIntegration.ts) never resolves when the shell does not
				// emit OSC 633 sequences for continuation prompts.
				//
				// Use sendText() to deliver the command (the shell handles continuation
				// prompts naturally), then obtain the execution output stream via the
				// onDidStartTerminalShellExecution event. This avoids the problematic
				// multi-line tracking code path entirely while preserving full stream output.
				const streamOrNull = await this.runViaSendText(terminal, command)
				if (!streamOrNull) {
					// sendText was already called inside runViaSendText; stream tracking
					// is not available (no shell integration events or timed out).
					this.emit("completed")
					this.emit("continue")
					this.emit("no_shell_integration")
					return
				}
				stream = streamOrNull
			} else {
				const execution = terminal.shellIntegration.executeCommand(command)
				stream = execution.read()
			}

			// todo: need to handle errors
			let isFirstChunk = true
			let didOutputNonCommand = false
			for await (let data of stream) {
				// 1. Process chunk and remove artifacts
				if (isFirstChunk) {
					/*
					The first chunk we get from this stream needs to be processed to be more human readable, ie remove vscode's custom escape sequences and identifiers, removing duplicate first char bug, etc.
					*/

					// bug where sometimes the command output makes its way into vscode shell integration metadata
					/*
					]633 is a custom sequence number used by VSCode shell integration:
					- OSC 633 ; A ST - Mark prompt start
					- OSC 633 ; B ST - Mark prompt end
					- OSC 633 ; C ST - Mark pre-execution (start of command output)
					- OSC 633 ; D [; <exitcode>] ST - Mark execution finished with optional exit code
					- OSC 633 ; E ; <commandline> [; <nonce>] ST - Explicitly set command line with optional nonce
					*/
					// if you print this data you might see something like "eecho hello worldo hello world;5ba85d14-e92a-40c4-b2fd-71525581eeb0]633;C" but this is actually just a bunch of escape sequences, ignore up to the first ;C
					/* ddateb15026-6a64-40db-b21f-2a621a9830f0]633;CTue Sep 17 06:37:04 EDT 2024 % ]633;D;0]633;P;Cwd=/Users/saoud/Repositories/test */
					// Gets output between ]633;C (command start) and ]633;D (command end)
					const outputBetweenSequences = this.removeLastLineArtifacts(
						data.match(/\]633;C([\s\S]*?)\]633;D/)?.[1] || "",
					).trim()

					// Once we've retrieved any potential output between sequences, we can remove everything up to end of the last sequence
					// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
					const vscodeSequenceRegex = /\x1b\]633;.[^\x07]*\x07/g
					const lastMatch = [...data.matchAll(vscodeSequenceRegex)].pop()
					if (lastMatch && lastMatch.index !== undefined) {
						data = data.slice(lastMatch.index + lastMatch[0].length)
					}
					// Place output back after removing vscode sequences
					if (outputBetweenSequences) {
						data = outputBetweenSequences + "\n" + data
					}
					// remove ansi
					data = stripAnsi(data)
					// Split data by newlines
					let lines = data ? data.split("\n") : []
					// Remove non-human readable characters from the first line
					if (lines.length > 0) {
						lines[0] = lines[0].replace(/[^\x20-\x7E]/g, "")
					}
					// Check if first two characters are the same, if so remove the first character
					if (lines.length > 0 && lines[0].length >= 2 && lines[0][0] === lines[0][1]) {
						lines[0] = lines[0].slice(1)
					}
					// Remove everything up to the first alphanumeric character for first two lines
					if (lines.length > 0) {
						lines[0] = lines[0].replace(/^[^a-zA-Z0-9]*/, "")
					}
					if (lines.length > 1) {
						lines[1] = lines[1].replace(/^[^a-zA-Z0-9]*/, "")
					}
					// Join lines back
					data = lines.join("\n")
					isFirstChunk = false
				} else {
					data = stripAnsi(data)
				}

				// first few chunks could be the command being echoed back, so we must ignore
				// note this means that 'echo' commands wont work
				if (!didOutputNonCommand) {
					const lines = data.split("\n")
					for (let i = 0; i < lines.length; i++) {
						if (command.includes(lines[i].trim())) {
							lines.splice(i, 1)
							i-- // Adjust index after removal
						} else {
							didOutputNonCommand = true
							break
						}
					}
					data = lines.join("\n")
				}

				// FIXME: right now it seems that data chunks returned to us from the shell integration stream contains random commas, which from what I can tell is not the expected behavior. There has to be a better solution here than just removing all commas.
				data = data.replace(/,/g, "")

				if (this.isListening) {
					this.emitIfEol(data)
				}
			}

			this.emitRemainingBufferIfListening()

			this.emit("completed")
			this.emit("continue")
		} else {
			terminal.sendText(command, true)
			// For terminals without shell integration, we can't know when the command completes
			// So we'll just emit the continue event after a delay
			this.emit("completed")
			this.emit("continue")
			this.emit("no_shell_integration")
			// setTimeout(() => {
			// 	console.log(`Emitting continue after delay for terminal`)
			// 	// can't emit completed since we don't if the command actually completed, it could still be running server
			// }, 500) // Adjust this delay as needed
		}
	}

	/**
	 * Send a command to the terminal via sendText and obtain the execution output
	 * stream through the onDidStartTerminalShellExecution event.
	 *
	 * This avoids VS Code's internal multi-line execution tracking which causes
	 * executeCommand().read() to hang when the command contains newline characters.
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
		// executeCommand as available after detecting OSC 633 markers, but the
		// shell's line editor typically activates slightly later. Sending text
		// while the PTY is still in cooked mode causes the terminal driver to
		// echo the characters, resulting in duplicate output.
		//
		// We first ensure CWD is detected (happens in precmd, right before the
		// prompt) and then add a fixed delay to let readline finish activating.
		// The flag is set by TerminalManager only for terminals that had to
		// wait for shell integration — existing terminals already have readline
		// active and skip the delay entirely.
		if (this.newTerminal) {
			if (terminal.shellIntegration && !terminal.shellIntegration.cwd) {
				try {
					await pWaitFor(() => !!terminal.shellIntegration?.cwd, {
						timeout: 5000,
						interval: 50,
					})
				} catch {
					// Timed out; proceed anyway.
				}
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
							resolve(e.execution.read())
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
