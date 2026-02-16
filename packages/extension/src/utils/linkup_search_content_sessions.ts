// Shared session registry for Linkup tools (linkup_search)
// Each session stores final markdown content for a single tool invocation and allows
// a webview panel to render it on demand via a command link.
import * as vscode from 'vscode'

export interface LinkupContentSession {
    uid: string
    tool: string // tool identifier (e.g. linkup_search)
    contentEmitter: vscode.EventEmitter<string>
    contentBuffer: string
    panel?: vscode.WebviewPanel
    dispose: () => void
}

type StoredLinkupContentSession = {
    uid: string
    tool: string
    contentBuffer: string
}

const STORAGE_KEY = 'reliefpilot.linkupSessions'

function getMaxEntries(): number {
    const cfg = vscode.workspace.getConfiguration('reliefpilot')
    const n = cfg.get<number>('linkupHistoryMaxEntries', 20)
    if (!Number.isFinite(n) || n <= 0) return 20
    return Math.max(1, Math.floor(n))
}

class LinkupSessionManager {
    private sessions: LinkupContentSession[] = []
    private storage?: vscode.Memento

    initStorage(memento: vscode.Memento) {
        this.storage = memento
        this.loadFromStorage()
    }

    private loadFromStorage() {
        if (!this.storage) return
        const data = this.storage.get<StoredLinkupContentSession[]>(STORAGE_KEY, []) || []
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

    private serialize(): StoredLinkupContentSession[] {
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

    createSession(uid: string, tool: string): LinkupContentSession {
        const contentEmitter = new vscode.EventEmitter<string>()
        const session: LinkupContentSession = {
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

    getSession(uid: string | undefined): LinkupContentSession | undefined {
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

const manager = new LinkupSessionManager()

export function initLinkupSessionStorage(context: vscode.ExtensionContext) {
    manager.initStorage(context.workspaceState)
}

export function createLinkupContentSession(uid: string, tool: string): LinkupContentSession {
    return manager.createSession(uid, tool)
}

export function getLinkupContentSession(uid: string | undefined): LinkupContentSession | undefined {
    return manager.getSession(uid)
}

export function finalizeLinkupSession(uid: string) {
    manager.finalizeSession(uid)
}

export function registerLinkupSessionConfigWatcher(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('reliefpilot.linkupHistoryMaxEntries')) {
                manager.applyLimitFromSettings()
            }
        })
    )
}
