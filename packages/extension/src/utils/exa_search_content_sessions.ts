// Shared session registry for Exa tools (exa_search)
// Each session stores final markdown content for a single tool invocation and allows
// a webview panel to render it on demand via a command link.
import * as vscode from 'vscode'

export interface ExaContentSession {
    uid: string
    tool: string // tool identifier (e.g. exa_search)
    contentEmitter: vscode.EventEmitter<string>
    contentBuffer: string
    panel?: vscode.WebviewPanel
    dispose: () => void
}

type StoredExaContentSession = {
    uid: string
    tool: string
    contentBuffer: string
}

const STORAGE_KEY = 'reliefpilot.exaSessions'

function getMaxEntries(): number {
    const cfg = vscode.workspace.getConfiguration('reliefpilot')
    const n = cfg.get<number>('exaHistoryMaxEntries', 20)
    if (!Number.isFinite(n) || n <= 0) return 20
    return Math.max(1, Math.floor(n))
}

class ExaSessionManager {
    private sessions: ExaContentSession[] = []
    private storage?: vscode.Memento

    initStorage(memento: vscode.Memento) {
        this.storage = memento
        this.loadFromStorage()
    }

    private loadFromStorage() {
        if (!this.storage) return
        const data = this.storage.get<StoredExaContentSession[]>(STORAGE_KEY, []) || []
        if (Array.isArray(data)) {
            this.sessions = data.map(s => {
                const contentEmitter = new vscode.EventEmitter<string>()
                return {
                    ...s,
                    contentEmitter,
                    panel: undefined,
                    dispose: () => { contentEmitter.dispose() }
                }
            })
            const max = getMaxEntries()
            if (this.sessions.length > max) {
                const removed = this.sessions.splice(max)
                removed.forEach(s => s.dispose())
                void this.saveToStorage()
            }
        }
    }

    private serialize(): StoredExaContentSession[] {
        return this.sessions.map(s => ({
            uid: s.uid,
            tool: s.tool,
            contentBuffer: s.contentBuffer
        }))
    }

    private async saveToStorage() {
        if (!this.storage) return
        try { await this.storage.update(STORAGE_KEY, this.serialize()) } catch { }
    }

    createSession(uid: string, tool: string): ExaContentSession {
        const contentEmitter = new vscode.EventEmitter<string>()
        const session: ExaContentSession = {
            uid,
            tool,
            contentEmitter,
            contentBuffer: '',
            panel: undefined,
            dispose: () => {
                contentEmitter.dispose()
            },
        }
        session.dispose = () => {
            contentEmitter.dispose()
            session.panel?.dispose()
        }
        this.sessions.unshift(session)
        const max = getMaxEntries()
        if (this.sessions.length > max) {
            const removed = this.sessions.splice(max)
            removed.forEach(s => s.dispose())
        }
        void this.saveToStorage()
        return session
    }

    getSession(uid: string | undefined): ExaContentSession | undefined {
        if (!uid) return undefined
        return this.sessions.find(s => s.uid === uid)
    }

    finalizeSession(uid: string) {
        const session = this.sessions.find(s => s.uid === uid)
        if (session) {
            void this.saveToStorage()
            session.dispose()
        }
    }

    applyLimitFromSettings() {
        const max = getMaxEntries()
        if (this.sessions.length > max) {
            const removed = this.sessions.splice(max)
            removed.forEach(s => { try { s.dispose() } catch { } })
            void this.saveToStorage()
        }
    }
}

const manager = new ExaSessionManager()

export function initExaSessionStorage(context: vscode.ExtensionContext) {
    manager.initStorage(context.workspaceState)
}

export function createExaContentSession(uid: string, tool: string): ExaContentSession {
    return manager.createSession(uid, tool)
}

export function getExaContentSession(uid: string | undefined): ExaContentSession | undefined {
    return manager.getSession(uid)
}

export function finalizeExaSession(uid: string) {
    manager.finalizeSession(uid)
}

export function registerExaSessionConfigWatcher(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('reliefpilot.exaHistoryMaxEntries')) {
                manager.applyLimitFromSettings()
            }
        })
    )
}
