// Token validation and recovery flow for Exa API.
// When an auth-like error is detected, triggers the internal setup command and returns whether retry is possible.
import * as vscode from 'vscode'

function extractErrorMessage(rawText: string): string {
    try {
        const parsed = JSON.parse(rawText)
        const msg1 = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        if (msg1) return msg1
        const msg2 = typeof parsed?.message === 'string' ? parsed.message : ''
        if (msg2) return msg2
        return ''
    } catch {
        return ''
    }
}

export async function validateExaTokenFromResponse(status: number, rawText: string): Promise<boolean> {
    if (status !== 401 && status !== 403) return false

    const lowerRaw = (rawText || '').toLowerCase()
    const lowerMsg = extractErrorMessage(rawText).toLowerCase()

    const authHints = [
        'api key',
        'x-api-key',
        'token',
        'bearer',
        'authorization',
        'unauthorized',
        'forbidden',
        'permission',
        'invalid',
        'missing',
    ]

    const looksLikeAuthIssue = status === 401 || authHints.some((p) => lowerRaw.includes(p) || lowerMsg.includes(p))
    if (!looksLikeAuthIssue) return false

    let entered: string | undefined
    try {
        entered = await vscode.commands.executeCommand('reliefpilot.exa.setupApiKey')
    } catch {
        entered = undefined
    }

    return !!entered
}
