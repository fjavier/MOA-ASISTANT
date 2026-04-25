import * as vscode from 'vscode';
import OpenAI from 'openai';

export class OllamaChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ollama-chat-view';
    private _view?: vscode.WebviewView;

    // CONFIGURACIÓN DE CONEXIÓN
    private openai = new OpenAI({
        baseURL: `http://192.168.1.36:11434/v1`, 
        apiKey: 'ollama',
    });

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        // Detectar cambios de selección en el editor activo
        const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            const selection = e.textEditor.document.getText(e.selections[0]);
            this._view?.webview.postMessage({ type: 'updateContext', value: selection });
        });

        // Recibir preguntas desde el Chat (HTML)
        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'askOllama') {
                await this._handleStreamResponse(data.value, data.context);
            }
        });

        webviewView.onDidDispose(() => selectionListener.dispose());
    }

    private async _handleStreamResponse(prompt: string, codeContext: string) {
        if (!this._view) return;

        try {
            const stream = await this.openai.chat.completions.create({
                model: "qwen2.5-coder:1.5b",
                messages: [
                    { role: "system", content: "Eres un programador experto. Responde de forma concisa usando el código proporcionado." },
                    { role: "user", content: `CONTEXTO:\n${codeContext}\n\nPREGUNTA: ${prompt}` }
                ],
                stream: true,
            });

            this._view.webview.postMessage({ type: 'startResponse' });

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                this._view.webview.postMessage({ type: 'addChunk', value: content });
            }
        } catch (err: any) {
            this._view.webview.postMessage({ type: 'addChunk', value: `\n❌ Error de conexión: ${err.message}` });
        }
    }

    private _getHtmlContent() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; display: flex; flex-direction: column; height: 100vh; margin: 0; box-sizing: border-box; }
                #chat { flex: 1; overflow-y: auto; margin-bottom: 10px; }
                .msg { margin-bottom: 12px; padding: 8px; border-radius: 5px; font-size: 13px; line-height: 1.5; word-wrap: break-word; }
                .user { background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-widget-border); }
                .ai { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-button-background); }
                #context-info { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; padding: 2px 5px; background: var(--vscode-input-background); border-radius: 3px; }
                textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; resize: none; font-family: inherit; }
                button { margin-top: 5px; padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; width: 100%; cursor: pointer; font-weight: bold; }
                button:hover { background: var(--vscode-button-hoverBackground); }
                code { background: #2d2d2d; padding: 2px 4px; border-radius: 3px; font-family: monospace; }
            </style>
        </head>
        <body>
            <div id="chat"></div>
            <div id="context-info">Sin selección</div>
            <textarea id="prompt" rows="3" placeholder="Pregunta sobre el código seleccionado..."></textarea>
            <button onclick="send()">Enviar a Qwen</button>

            <script>
                const vscode = acquireVsCodeApi();
                let lastSelection = "";
                let currentAiDiv = null;

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.type === 'updateContext') {
                        lastSelection = m.value;
                        document.getElementById('context-info').innerText = m.value ? "📎 Selección: " + m.value.substring(0, 30) + "..." : "Sin selección";
                    }
                    if (m.type === 'startResponse') {
                        currentAiDiv = document.createElement('div');
                        currentAiDiv.className = 'msg ai';
                        document.getElementById('chat').appendChild(currentAiDiv);
                    }
                    if (m.type === 'addChunk') {
                        currentAiDiv.innerText += m.value;
                        const chat = document.getElementById('chat');
                        chat.scrollTop = chat.scrollHeight;
                    }
                });

                function send() {
                    const input = document.getElementById('prompt');
                    const val = input.value;
                    if(!val) return;

                    const userDiv = document.createElement('div');
                    userDiv.className = 'msg user';
                    userDiv.innerText = val;
                    document.getElementById('chat').appendChild(userDiv);

                    vscode.postMessage({ type: 'askOllama', value: val, context: lastSelection });
                    input.value = '';
                }
            </script>
        </body>
        </html>`;
    }
}