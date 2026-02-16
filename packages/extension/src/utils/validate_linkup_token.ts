import * as vscode from 'vscode'

function extractErrorMessage(rawText: string): string {
    try {
        const parsed = JSON.parse(rawText)
        const top = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        if (top) return top
        return ''
    } catch {
        return ''
    }
}

export async function validateLinkupTokenFromResponse(status: number, rawText: string): Promise<boolean> {
    if (status !== 401 && status !== 403) return false

    const lowerRaw = rawText.toLowerCase()
    const lowerMsg = extractErrorMessage(rawText).toLowerCase()

    const authHints = [
        'api key',
        'token',
        'bearer',
        'authorization',
        'unauthorized',
        'forbidden',
        'permission',
    ]

    const looksLikeAuthIssue = status === 401 || authHints.some((p) => lowerRaw.includes(p) || lowerMsg.includes(p))
    if (!looksLikeAuthIssue) return false

    let entered: string | undefined
    try {
        entered = await vscode.commands.executeCommand('reliefpilot.linkup.setupApiKey')
    } catch {
        entered = undefined
    }

    return !!entered
}
