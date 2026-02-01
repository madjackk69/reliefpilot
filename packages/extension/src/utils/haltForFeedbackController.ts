import type { CancellationToken } from 'vscode'
import * as vscode from 'vscode'

export type HaltForFeedbackState =
    | { kind: 'running' }
    | { kind: 'paused'; draftFeedback: string }
    | { kind: 'declined'; feedback: string }

export class HaltForFeedbackController {
    private state: HaltForFeedbackState = { kind: 'running' }
    private readonly emitter = new vscode.EventEmitter<HaltForFeedbackState>()

    readonly onDidChangeState = this.emitter.event

    getSnapshot(): HaltForFeedbackState {
        return this.state
    }

    isPaused(): boolean {
        return this.state.kind === 'paused'
    }

    isDeclined(): boolean {
        return this.state.kind === 'declined'
    }

    pause(draft?: string) {
        this.state = { kind: 'paused', draftFeedback: draft ?? '' }
        this.emitter.fire(this.state)
    }

    resume() {
        this.state = { kind: 'running' }
        this.emitter.fire(this.state)
    }

    decline(feedback: string) {
        this.state = { kind: 'declined', feedback }
        this.emitter.fire(this.state)
    }

    /**
     * Wait until the controller is not in paused state.
     * Returns a snapshot of the first observed non-paused state.
     */
    async waitUntilNotPaused(token: CancellationToken): Promise<HaltForFeedbackState> {
        if (token.isCancellationRequested) {
            return this.getSnapshot()
        }

        const initial = this.getSnapshot()
        if (initial.kind !== 'paused') {
            return initial
        }

        return await new Promise<HaltForFeedbackState>((resolve) => {
            let settled = false

            const finalize = (snapshot: HaltForFeedbackState) => {
                if (settled) return
                settled = true
                try { stateDisposable.dispose() } catch { /* noop */ }
                try { tokenDisposable.dispose() } catch { /* noop */ }
                resolve(snapshot)
            }

            const stateDisposable = this.onDidChangeState((snapshot) => {
                if (snapshot.kind !== 'paused') {
                    finalize(snapshot)
                }
            })

            const tokenDisposable = token.onCancellationRequested(() => {
                finalize(this.getSnapshot())
            })
        })
    }

    /**
     * If currently declined, returns feedback and resets state to running.
     * Otherwise returns undefined.
     */
    takeDeclineAndReset(): string | undefined {
        if (this.state.kind !== 'declined') {
            return undefined
        }
        const feedback = this.state.feedback
        this.state = { kind: 'running' }
        this.emitter.fire(this.state)
        return feedback
    }
}

export const haltForFeedbackController = new HaltForFeedbackController()
