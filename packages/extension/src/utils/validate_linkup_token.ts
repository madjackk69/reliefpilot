import * as vscode from 'vscode'

function extractErrorMessage(rawText: string): string {
    try {
        const parsed = JSON.parse(rawText)
        const top = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        if (top) return top
        const msg = typeof parsed?.message === 'string' ? parsed.message : ''
        if (msg) return msg
        return ''
    } catch {
        return ''
    }
}

export async function validateLinkupTokenFromResponse(status: number, rawText: string): Promise<boolean> {
    // Per Linkup docs: invalid API key => 401 Unauthorized.
    // 400 is reserved for missing/invalid parameters, so we should not trigger token setup on 400.
    if (status !== 401) return false

    // Keep a lightweight safeguard: only prompt if the payload *mentions* auth/key,
    // to avoid false positives in case Linkup changes semantics.
    const lowerRaw = (rawText || '').toLowerCase()
    const lowerMsg = extractErrorMessage(rawText).toLowerCase()
    const keyHints = ['api key', 'token', 'bearer', 'authorization', 'unauthorized']
    const looksLikeAuthIssue = keyHints.some((p) => lowerRaw.includes(p) || lowerMsg.includes(p)) || lowerRaw.length === 0
    if (!looksLikeAuthIssue) return false

    let entered: string | undefined
    try {
        entered = await vscode.commands.executeCommand('reliefpilot.linkup.setupApiKey')
    } catch {
        entered = undefined
    }

    return !!entered
}
