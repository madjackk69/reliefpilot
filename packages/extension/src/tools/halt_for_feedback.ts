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
      @keyframes voice-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
    </style>
  </head>
  <body>
    <div class="halt__container">
      <section class="halt__banner" aria-label="Halt for Feedback">
        <h2 class="halt__title">Execution is paused</h2>
        <p class="halt__subtitle">Resume work, or cancel the current tool execution by sending feedback.</p>
      </section>

      <div style="position:relative;">
        <textarea id="feedback" class="textarea" aria-label="Feedback" placeholder="Type feedback…"></textarea>
        <button id="voiceBtn" class="btn secondary icon-btn voice-btn" aria-label="Voice input" title="Voice input"></button>
      </div>

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

      // Keyboard shortcuts:
      // - ESC closes the panel (resume work)
      // - Ctrl/Cmd+Enter sends feedback
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          persistState();
          vscode.postMessage({ type: 'resume' });
          return;
        }
        const isSubmitCombo = (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey));
        if (!isSubmitCombo) return;
        ev.preventDefault();
        if (sendBtn.disabled) return;
        const text = (textarea.value || '').trim();
        if (!text) return;
        persistState();
        vscode.postMessage({ type: 'send', value: text });
      });

      // Voice input: handled by extension host (VS Code Speech integration via showInputBox)
      const haltVoiceBtn = /** @type {HTMLButtonElement} */ (document.getElementById('voiceBtn'));

      function setHaltVoiceIcon(active) {
        if (!haltVoiceBtn) return;
        if (active) {
          haltVoiceBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="22" x2="16" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        } else {
          haltVoiceBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="22" x2="16" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        }
      }

      function setHaltVoiceBtnState(active) {
        if (!haltVoiceBtn) return;
        if (active) {
          haltVoiceBtn.setAttribute('aria-label', 'Waiting for voice input…');
          haltVoiceBtn.setAttribute('title', 'Waiting for voice input…');
          haltVoiceBtn.classList.add('recording');
        } else {
          haltVoiceBtn.setAttribute('aria-label', 'Voice input');
          haltVoiceBtn.setAttribute('title', 'Voice input');
          haltVoiceBtn.classList.remove('recording');
        }
        setHaltVoiceIcon(active);
      }

      if (haltVoiceBtn) {
        setHaltVoiceIcon(false);
        haltVoiceBtn.addEventListener('click', () => {
          setHaltVoiceBtnState(true);
          vscode.postMessage({ type: 'startVoice', currentText: textarea.value || '' });
        });
      }

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
        if (msg.type === 'voiceResult') {
          setHaltVoiceBtnState(false);
          if (typeof msg.text === 'string') {
            textarea.value = msg.text;
            updateSendState();
            persistState();
            vscode.postMessage({ type: 'draft', value: msg.text });
          }
        }
        if (msg.type === 'voicePartial') {
          if (typeof msg.text === 'string') {
            textarea.value = msg.text;
            updateSendState();
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
        panel.webview.onDidReceiveMessage(async (msg: any) => {
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
            if (msg.type === 'startVoice') {
                const currentText = typeof msg.currentText === 'string' ? msg.currentText : ''
                const inputBox = vscode.window.createInputBox()
                inputBox.value = currentText
                inputBox.prompt = 'Speak (click 🎤 for VS Code Speech) or type, then press Enter'
                inputBox.placeholder = 'Type or speak your feedback…'
                inputBox.ignoreFocusOut = true
                let finalValue: string | undefined
                const d1 = inputBox.onDidChangeValue((value) => {
                    try { panel.webview.postMessage({ type: 'voicePartial', text: value }) } catch { /* ignore */ }
                })
                const d2 = inputBox.onDidAccept(() => {
                    finalValue = inputBox.value
                    inputBox.hide()
                })
                const d3 = inputBox.onDidHide(() => {
                    d1.dispose(); d2.dispose(); d3.dispose()
                    inputBox.dispose()
                    try { panel.webview.postMessage({ type: 'voiceResult', text: finalValue }) } catch { /* ignore */ }
                })
                inputBox.show()
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
