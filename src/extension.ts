import * as vscode from 'vscode';
import { OllamaChatProvider } from './chatProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new OllamaChatProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OllamaChatProvider.viewType, provider)
    );
}

export function deactivate() {}