import * as vscode from 'vscode'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'

let haltPanel: vscode.WebviewPanel | undefined

export async function openOrFocusHaltForFeedback(): Promise<void> {
    const snapshot = haltForFeedbackController.getSnapshot()

    // If panel already exists, just focus it and optionally sync current draft.
    if (haltPanel) {
        try { haltPanel.reveal(undefined, false) } catch { /* ignore */ }
        if (snapshot.kind === 'paused') {
            try { void haltPanel.webview.postMessage({ type: 'sync', draft: snapshot.draftFeedback }) } catch { /* ignore */ }
        }
        return
    }

    let initialValue = ''

    if (snapshot.kind === 'running') {
        haltForFeedbackController.pause('')
        initialValue = ''
    } else if (snapshot.kind === 'paused') {
        initialValue = snapshot.draftFeedback
    } else {
        // declined: reopen with previous feedback, and switch back to paused
        initialValue = snapshot.feedback
        haltForFeedbackController.pause(initialValue)
    }

    const extensionUri = env.extensionUri
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')

    const panel = vscode.window.createWebviewPanel(
        'reliefpilot.haltForFeedback',
        'Halt for Feedback',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [mediaRoot],
        },
    )

    haltPanel = panel

    // Panel icon (optional, keep consistent with extension)
    try {
      panel.iconPath = vscode.Uri.joinPath(extensionUri, 'icon.png')
    } catch {
        // ignore icon assignment errors
    }

    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'ask_report.css'))

    const nonce = generateNonce()
    const csp = [
        "default-src 'none'",
        `img-src ${panel.webview.cspSource} blob: data:`,
        `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ')

    const bootstrapPayload = {
        initialValue,
    }

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Halt for Feedback</title>
    <style>
      /* Tight, pleasant layout; reuse ask_report styles for inputs/buttons */
      body { padding: 16px; }
      .halt__container { display: grid; gap: 12px; max-width: 900px; }
      .halt__banner {
        display: grid;
        gap: 6px;
        padding: 12px 12px;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 10px;
        background: var(--vscode-editorWidget-background, transparent);
      }
      .halt__title {
        margin: 0;
        font-size: 1.2rem;
        font-weight: 650;
        line-height: 1.25;
      }
      .halt__subtitle {
        margin: 0;
        opacity: 0.85;
        max-width: 80ch;
      }
      textarea { display: block; }
      .actions { justify-content: center; }
    </style>
  </head>
  <body>
    <div class="halt__container">
      <section class="halt__banner" aria-label="Halt for Feedback">
        <h2 class="halt__title">Execution is paused</h2>
        <p class="halt__subtitle">Resume work, or cancel the current tool execution by sending feedback.</p>
      </section>

      <textarea id="feedback" class="textarea" aria-label="Feedback" placeholder="Type feedback…"></textarea>

      <div class="actions" role="group" aria-label="Actions">
        <button id="resumeBtn" class="btn">Resume work</button>
        <button id="sendBtn" class="btn primary" disabled>Send feedback</button>
      </div>
    </div>

    <script nonce="${nonce}">const BOOTSTRAP = ${serializeForHtmlScriptTag(bootstrapPayload)};</script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('feedback'));
      const resumeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('resumeBtn'));
      const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sendBtn'));

      function updateSendState() {
        sendBtn.disabled = (textarea.value || '').trim().length === 0;
      }

      function persistState() {
        try {
          vscode.setState({ textareaValue: textarea.value || '' });
        } catch {}
      }

      // Restore from webview state first, otherwise use extension-provided initial value.
      const saved = vscode.getState() || {};
      const initial = (typeof saved.textareaValue === 'string')
        ? saved.textareaValue
        : (BOOTSTRAP && typeof BOOTSTRAP.initialValue === 'string' ? BOOTSTRAP.initialValue : '');

      textarea.value = initial;
      updateSendState();
      persistState();

      textarea.addEventListener('input', () => {
        updateSendState();
        persistState();
        vscode.postMessage({ type: 'draft', value: textarea.value || '' });
      });

      resumeBtn.addEventListener('click', () => {
        persistState();
        vscode.postMessage({ type: 'resume' });
      });

      sendBtn.addEventListener('click', () => {
        const text = (textarea.value || '').trim();
        if (!text) return;
        persistState();
        vscode.postMessage({ type: 'send', value: text });
      });

      // Keyboard shortcut: Ctrl/Cmd+Enter sends feedback
      document.addEventListener('keydown', (ev) => {
        const isSubmitCombo = (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey));
        if (!isSubmitCombo) return;
        ev.preventDefault();
        if (sendBtn.disabled) return;
        const text = (textarea.value || '').trim();
        if (!text) return;
        persistState();
        vscode.postMessage({ type: 'send', value: text });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'sync' && typeof msg.draft === 'string') {
          // Only auto-fill when current value is empty to avoid overwriting the user's edits.
          if ((textarea.value || '').trim().length === 0 && msg.draft.trim().length > 0) {
            textarea.value = msg.draft;
            updateSendState();
            persistState();
          }
        }
      });

      // Focus the textarea on open.
      try { textarea.focus(); } catch {}
    </script>
  </body>
</html>`

    const disposables: vscode.Disposable[] = []

    // If the global state is changed externally (e.g. a tool resets paused -> running),
    // keep the Halt for Feedback panel in sync by closing it when it is no longer paused.
    disposables.push(
      haltForFeedbackController.onDidChangeState((snapshot) => {
        if (snapshot.kind !== 'paused') {
          try { panel.dispose() } catch { /* ignore */ }
        }
      }),
    )

    disposables.push(
        panel.webview.onDidReceiveMessage((msg: any) => {
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'draft') {
                const value = typeof msg.value === 'string' ? msg.value : ''
                if (haltForFeedbackController.isPaused()) {
                    haltForFeedbackController.pause(value)
                }
                return
            }
            if (msg.type === 'resume') {
                haltForFeedbackController.resume()
                try { panel.dispose() } catch { /* ignore */ }
                return
            }
            if (msg.type === 'send') {
                const value = typeof msg.value === 'string' ? msg.value : ''
                const trimmed = value.trim()
                if (trimmed.length === 0) {
                    return
                }
                haltForFeedbackController.decline(trimmed)
                try { panel.dispose() } catch { /* ignore */ }
                return
            }
        }),
    )

    disposables.push(
        panel.onDidDispose(() => {
            haltPanel = undefined

            // If user closed the panel while still paused (Esc / X), resume.
            if (haltForFeedbackController.isPaused()) {
                haltForFeedbackController.resume()
            }

            for (const d of disposables) {
                try { d.dispose() } catch { /* noop */ }
            }
        }),
    )
}

function generateNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let text = ''
    for (let i = 0; i < 16; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
}

function serializeForHtmlScriptTag(value: unknown): string {
    // Escape characters that can break out of a <script> tag or change parsing semantics.
    // Keep this minimal and deterministic: JSON + a few safe replacements.
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
}
