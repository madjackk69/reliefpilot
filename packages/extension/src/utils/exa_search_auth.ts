// Exa authorization utilities for API token management
// Stores context reference and provides token read/write operations
import * as vscode from 'vscode'

const EXA_API_KEY_SECRET_KEY = 'reliefpilot.exa.apiKey'

let extensionContext: vscode.ExtensionContext | undefined

export function initExaAuth(context: vscode.ExtensionContext): void {
    extensionContext = context
}

async function getSecret(key: string): Promise<string | undefined> {
    if (!extensionContext) return undefined
    const value = await extensionContext.secrets.get(key)
    return value && value.trim().length > 0 ? value.trim() : undefined
}

async function updateSecret(options: {
    key: string
    title: string
    placeHolder: string
    password?: boolean
}): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: options.title,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true,
        password: options.password ?? false,
    })
    if (input === undefined) return undefined

    const trimmed = input.trim()
    if (!extensionContext) return undefined

    if (trimmed.length === 0) {
        await extensionContext.secrets.delete(options.key)
        void vscode.window.showInformationMessage(`Exa API token \`${options.title}\` deleted.`)
        return undefined
    }

    await extensionContext.secrets.store(options.key, trimmed)
    return trimmed
}

export async function setupOrUpdateExaApiKey(): Promise<string | undefined> {
    try {
        const value = await updateSecret({
            key: EXA_API_KEY_SECRET_KEY,
            title: 'EXA_API_KEY',
            placeHolder: 'Paste your Exa API key (EXA_API_KEY)',
            password: true,
        })
        if (value) {
            void vscode.window.showInformationMessage('Exa API token `EXA_API_KEY` stored securely.')
        }
        return value
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to store EXA_API_KEY token: ${message}`)
        return undefined
    }
}

export async function hasExaApiKey(): Promise<boolean> {
    return !!(await getSecret(EXA_API_KEY_SECRET_KEY))
}

export async function getExaApiKey(): Promise<string | undefined> {
    return await getSecret(EXA_API_KEY_SECRET_KEY)
}
