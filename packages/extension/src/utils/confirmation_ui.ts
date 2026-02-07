import * as vscode from 'vscode';

/**
 * InputBox
 */
export class ConfirmationUI {
  /**
   * Show an InputBox-based confirmation with editable command text.
   * Returns the user's decision and the (possibly edited) command.
   */
  static async confirmCommandWithInputBox(
    message: string,
    initialCommand: string,
    approveLabel: string,
    denyLabel: string
  ): Promise<{ decision: 'Approve' | 'Deny'; command: string; feedback?: string }> {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = message;
    inputBox.value = initialCommand;
    // Place cursor at the start without selection
    inputBox.valueSelection = [0, 0];
    inputBox.ignoreFocusOut = true;

    const supportsQuickInputButtonLocation = typeof (vscode as any).QuickInputButtonLocation?.Inline === 'number';

    const approveButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: approveLabel,
    };
    if (supportsQuickInputButtonLocation) {
      (approveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2;
    }
    const denyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('x'),
      tooltip: denyLabel,
    };
    inputBox.buttons = [approveButton, denyButton];

    return await new Promise((resolve) => {
      let handled = false; // set true when approve/deny button is used
      const approve = () => {
        handled = true;
        const cmd = inputBox.value;
        inputBox.hide();
        inputBox.dispose();
        resolve({ decision: 'Approve', command: cmd });
      };
      const deny = async () => {
        handled = true;
        const cmd = inputBox.value;
        inputBox.hide();
        // Ask optional feedback similar to other UIs
        const fb = vscode.window.createInputBox();
        fb.title = 'Feedback';
        fb.placeholder = 'Add context for the agent (optional)';
        fb.ignoreFocusOut = true;
        const fbApproveButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('send'),
          tooltip: 'Send feedback',
        };
        if (supportsQuickInputButtonLocation) {
          (fbApproveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2;
        }
        const fbBackButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('arrow-left'),
          tooltip: 'Back to command',
        };
        fb.buttons = [fbApproveButton, fbBackButton];
        let sent = false;
        fb.onDidAccept(() => {
          sent = true;
          const feedback = fb.value.trim();
          fb.hide();
          fb.dispose(); // Dispose fb when feedback is sent
          inputBox.dispose(); // Dispose inputBox when feedback is sent
          resolve({ decision: 'Deny', command: cmd, feedback: feedback || undefined });
        });
        fb.onDidTriggerButton((btn) => {
          if (btn === fbApproveButton) {
            sent = true;
            const feedback = fb.value.trim();
            fb.hide();
            fb.dispose(); // Dispose fb when feedback is sent
            inputBox.dispose(); // Dispose inputBox when feedback is sent
            resolve({ decision: 'Deny', command: cmd, feedback: feedback || undefined });
          } else if (btn === fbBackButton) {
            fb.hide();
            fb.dispose(); // Dispose fb when going back
            // 1. approve() -> dispose inputBox, resolve.
            // 2. deny() -> hide inputBox (don't dispose yet). show fb.
            // 3. fb completes (accept/button) -> dispose fb, dispose inputBox, resolve.
            // 4. fb back -> hide fb, dispose fb, show inputBox.
          }
        });
        fb.onDidHide(() => {
          // ESC/close or Back button => return to command (unless feedback was sent)
          if (!sent) {
            handled = false; // allow main input to decide later
            fb.dispose(); // Dispose fb when it hides
            inputBox.show();
          }
        });
        fb.show();
      };

      inputBox.onDidTriggerButton((btn) => {
        if (btn === approveButton) {
          approve();
        } else if (btn === denyButton) {
          deny();
        }
      });
      inputBox.onDidAccept(() => {
        // Enter acts as Approve
        approve();
      });
      inputBox.onDidHide(() => {
        // ESC/close behaves like clicking Deny -> open feedback flow
        if (!handled) {
          deny();
        }
      });
      inputBox.show();
    });
  }

  /**
   * Shows an InputBox-based confirmation UI.
   * @param message Confirmation message.
   * @param detail Additional details (e.g., command).
   * @param approveLabel Label for the approve button.
   * @param denyLabel Label for the deny button.
   * @returns "Approve" if approved, or "Deny" or a reason text if denied.
   */
  static async confirm(message: string, detail: string, approveLabel: string, denyLabel: string): Promise<string> {
    return await this.showInputBoxConfirmation(message, detail, approveLabel, denyLabel);
  }

  /**
   * Show an InputBox-based confirmation with approve/deny buttons.
   * Unlike confirmCommandWithInputBox, any edited value is ignored and only a decision or feedback is returned.
   */
  private static async showInputBoxConfirmation(
    message: string,
    detail: string,
    approveLabel: string,
    denyLabel: string
  ): Promise<string> {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = message;
    inputBox.value = detail || '';
    inputBox.placeholder = detail ? '' : '';
    inputBox.ignoreFocusOut = true;

    const supportsQuickInputButtonLocation = typeof (vscode as any).QuickInputButtonLocation?.Inline === 'number';

    const approveButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: approveLabel,
    };
    const denyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('x'),
      tooltip: denyLabel,
    };
    inputBox.buttons = [approveButton, denyButton];

    return await new Promise<string>((resolve) => {
      let handled = false;
      const approve = () => {
        handled = true;
        inputBox.hide();
        inputBox.dispose();
        resolve('Approve');
      };
      const deny = async () => {
        handled = true;
        inputBox.hide();

        // Ask optional feedback similar to other UIs
        const fb = vscode.window.createInputBox();
        fb.title = 'Feedback';
        fb.placeholder = 'Add context for the agent (optional)';
        fb.ignoreFocusOut = true;
        const fbApproveButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('send'),
          tooltip: 'Send feedback',
        };
        if (supportsQuickInputButtonLocation) {
          (fbApproveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2;
        }
        const fbBackButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('arrow-left'),
          tooltip: 'Back to confirmation',
        };
        fb.buttons = [fbApproveButton, fbBackButton];
        let sent = false;
        fb.onDidAccept(() => {
          sent = true;
          const feedback = fb.value.trim();
          fb.hide();
          fb.dispose();
          inputBox.dispose();
          resolve(feedback || 'Deny');
        });
        fb.onDidTriggerButton((btn) => {
          if (btn === fbApproveButton) {
            sent = true;
            const feedback = fb.value.trim();
            fb.hide();
            fb.dispose();
            inputBox.dispose();
            resolve(feedback || 'Deny');
          } else if (btn === fbBackButton) {
            fb.hide();
            fb.dispose();
          }
        });
        fb.onDidHide(() => {
          // ESC/close or Back button => return to main input (unless feedback was sent)
          if (!sent) {
            handled = false;
            fb.dispose();
            inputBox.show();
          }
        });
        fb.show();
      };

      inputBox.onDidTriggerButton((btn) => {
        if (btn === approveButton) {
          approve();
        } else if (btn === denyButton) {
          deny();
        }
      });
      inputBox.onDidAccept(() => {
        approve();
      });
      inputBox.onDidHide(() => {
        if (!handled) {
          deny();
        }
      });
      inputBox.show();
    });
  }

}
