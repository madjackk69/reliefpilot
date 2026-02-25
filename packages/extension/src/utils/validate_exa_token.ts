// Token validation and recovery flow for Exa API.
// When an auth-like error is detected, triggers the internal setup command and returns whether retry is possible.
import * as vscode from 'vscode'

function extractErrorMessage(rawText: string): string {
    try {
        const parsed = JSON.parse(rawText)
        // Exa errors are typically shaped like:
        // { requestId: string, error: string, tag: string }
        const topError = typeof parsed?.error === 'string' ? parsed.error : ''
        if (topError) return topError

        // Backward/alternate shapes (just in case)
        const nested = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        if (nested) return nested

        const msg = typeof parsed?.message === 'string' ? parsed.message : ''
        if (msg) return msg
        return ''
    } catch {
        return ''
    }
}

function extractErrorTag(rawText: string): string {
    try {
        const parsed = JSON.parse(rawText)
        const tag = typeof parsed?.tag === 'string' ? parsed.tag : ''
        return tag
    } catch {
        return ''
    }
}

export async function validateExaTokenFromResponse(status: number, rawText: string): Promise<boolean> {
    // Per Exa docs:
    // - INVALID_API_KEY => 401 (API key is missing, empty, or invalid)
    // Source: https://docs.exa.ai/reference/error-codes
    const tag = extractErrorTag(rawText)
    const isInvalidApiKey = tag.toUpperCase() === 'INVALID_API_KEY'

    // Observed Exa behavior: when header is present but empty, API may return 400 with message:
    // "x-api-key header must not be empty"
    // Treat this as an auth-like issue and prompt for token.
    const lowerRaw = (rawText || '').toLowerCase()
    const lowerMsg = extractErrorMessage(rawText).toLowerCase()

    const isEmptyKeyHeader = lowerMsg.includes('x-api-key header must not be empty')
        || lowerRaw.includes('x-api-key header must not be empty')

    if (status !== 401 && !isInvalidApiKey && !(status === 400 && isEmptyKeyHeader)) {
        return false
    }

    // Additional safeguard: ensure the message mentions API key/auth.
    const hints = ['api key', 'x-api-key', 'authorization', 'bearer', 'token', 'unauthorized']
    const looksLikeAuthIssue = isInvalidApiKey
        || isEmptyKeyHeader
        || hints.some((p) => lowerRaw.includes(p) || lowerMsg.includes(p))
        || lowerRaw.length === 0
    if (!looksLikeAuthIssue) return false

    let entered: string | undefined
    try {
        entered = await vscode.commands.executeCommand('reliefpilot.exa.setupApiKey')
    } catch {
        entered = undefined
    }

    return !!entered
}
