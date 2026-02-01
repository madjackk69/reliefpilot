import * as vscode from 'vscode'
import { haltForFeedbackController } from './haltForFeedbackController'

// Centralized status bar activity tracker for the extension.
// Tracks concurrent tool invocations and toggles spinner/robot icon accordingly.
class StatusBarActivityTracker {
    private item: vscode.StatusBarItem | undefined
    private readonly label: string
    private activeCount = 0
    private readonly sources = new Map<string, number>()
    private haltStateDisposable: vscode.Disposable | undefined

    constructor(label: string = 'Relief Pilot') {
        this.label = label
    }

    // Initialize tracker with the created StatusBarItem
    init(item: vscode.StatusBarItem) {
        this.item = item
        // Re-render when Halt for Feedback state changes
        try { this.haltStateDisposable?.dispose() } catch { /* noop */ }
        this.haltStateDisposable = haltForFeedbackController.onDidChangeState(() => this.update())
        this.update()
    }

    // Mark activity start for a given source (tool id)
    start(source: string) {
        const n = this.sources.get(source) ?? 0
        this.sources.set(source, n + 1)
        this.activeCount += 1
        this.update()
    }

    // Mark activity end for a given source (tool id)
    end(source: string) {
        const n = this.sources.get(source) ?? 0
        if (n <= 1) {
            this.sources.delete(source)
        } else {
            this.sources.set(source, n - 1)
        }
        if (this.activeCount > 0) {
            this.activeCount -= 1
        }
        this.update()
    }

    // Render the status bar text and tooltip
    private update() {
        if (!this.item) return

        const isBusy = this.activeCount > 0
        const haltState = haltForFeedbackController.getSnapshot()
        if (haltState.kind === 'paused') {
            // Show pause indicator to the left of extension icon
            this.item.text = '$(debug-pause) $(reliefpilot-logo) RP'
        } else if (haltState.kind === 'declined') {
            // Show feedback indicator to the left of extension icon
            this.item.text = '$(send) $(reliefpilot-logo) RP'
        } else {
            // Use VS Code codicon spinner when busy; custom ReliefPilot logo otherwise; always show short label next to icon
            this.item.text = `${isBusy ? '$(sync~spin)' : '$(reliefpilot-logo)'} RP`
        }

        // Compose tooltip with brief activity summary
        if (isBusy) {
            const parts: string[] = []
            for (const [src, count] of this.sources) {
                parts.push(`${src}:${count}`)
            }
            const detail = parts.length > 0 ? ` — ${parts.join(', ')}` : ''
            this.item.tooltip = `${this.label}: Working (active: ${this.activeCount})${detail}`
        } else {
            this.item.tooltip = `${this.label}: Idle`
        }

        this.item.show()
    }
}

// Export a singleton tracker shared across the extension
export const statusBarActivity = new StatusBarActivityTracker('Relief Pilot')
