import * as vscode from 'vscode';
import OpenAI from 'openai';

export class OllamaChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ollama-chat-view';
    private _view?: vscode.WebviewView;
    private readonly baseUrl = `http://192.168.1.36:11434/v1`;
    
    // MEMORIA: Guardamos los últimos mensajes (máximo 6 para no saturar al 1.5B)
    private messageHistory: { role: "user" | "assistant", content: string }[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlContent();

        const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            const selection = e.textEditor.document.getText(e.selections[0]);
            this._view?.webview.postMessage({ type: 'updateContext', value: selection });
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'askOllama') {
                await this._handleStreamResponse(data.value, data.context);
            } else if (data.type === 'clearChat') {
                this.messageHistory = []; // Opción para resetear memoria
            }
        });

        webviewView.onDidDispose(() => selectionListener.dispose());
    }

    private async _handleStreamResponse(prompt: string, codeContext: string) {
        if (!this._view) return;

        try {
            const openai = new OpenAI({
                baseURL: this.baseUrl,
                apiKey: 'ollama',
                maxRetries: 0,
                timeout: 7000
            });

            // 1. Construir el prompt de sistema con el código actual
            const systemMessage = { 
                role: "system" as const, 
                content: `Eres un programador experto. CÓDIGO ACTUAL SELECCIONADO:\n${codeContext}\nUsa este código como referencia principal.` 
            };

            // 2. Combinar historial + pregunta actual
            const currentMessages = [
                systemMessage,
                ...this.messageHistory,
                { role: "user" as const, content: prompt }
            ];

            const stream = await openai.chat.completions.create({
                model: "qwen2.5-coder:1.5b",
                messages: currentMessages,
                stream: true,
            });

            this._view.webview.postMessage({ type: 'startResponse' });

            let fullAiResponse = "";
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                fullAiResponse += content;
                this._view.webview.postMessage({ type: 'addChunk', value: content });
            }

            // 3. GUARDAR EN MEMORIA (Pregunta + Respuesta)
            this.messageHistory.push({ role: "user", content: prompt });
            this.messageHistory.push({ role: "assistant", content: fullAiResponse });

            // Mantener solo los últimos 6 mensajes (3 vueltas de chat) para no exceder el contexto
            if (this.messageHistory.length > 6) {
                this.messageHistory = this.messageHistory.slice(-6);
            }

        } catch (err: any) {
            this._view.webview.postMessage({ type: 'showError', value: err.message || "Error de conexión" });
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
                .msg { margin-bottom: 12px; padding: 10px; border-radius: 5px; font-size: 13px; line-height: 1.5; }
                .user { background: var(--vscode-button-secondaryBackground); align-self: flex-end; border: 1px solid var(--vscode-widget-border); }
                .ai { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-button-background); white-space: pre-wrap; }
                .error { background: #5a1d1d; color: #ffbcbc; border: 1px solid #ff0000; }
                .thinking { font-style: italic; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 5px 0; }
                #context-status { font-size: 10px; opacity: 0.7; margin-bottom: 5px; }
                textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; resize: none; font-family: inherit; }
                .controls { display: flex; gap: 5px; margin-top: 5px; }
                button { flex: 4; padding: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; font-weight: bold; }
                .btn-clear { flex: 1; background: var(--vscode-button-secondaryBackground); font-size: 10px; }
                button:hover { opacity: 0.8; }
            </style>
        </head>
        <body>
            <div id="chat"></div>
            <div id="context-status">Sin selección</div>
            <textarea id="prompt" rows="3" placeholder="Pregunta sobre el código..."></textarea>
            <div class="controls">
                <button onclick="send()">Enviar a Qwen</button>
                <button class="btn-clear" onclick="clearHistory()" title="Limpiar Memoria">🗑️</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let currentAiDiv = null;
                let thinkingDiv = null;
                let lastContext = "";

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.type === 'updateContext') {
                        lastContext = m.value;
                        document.getElementById('context-status').innerText = m.value ? "📎 Contexto: " + m.value.substring(0, 20) + "..." : "Sin selección";
                    }
                    if (m.type === 'startResponse') {
                        if (thinkingDiv) { thinkingDiv.remove(); thinkingDiv = null; }
                        currentAiDiv = document.createElement('div');
                        currentAiDiv.className = 'msg ai';
                        document.getElementById('chat').appendChild(currentAiDiv);
                    }
                    if (m.type === 'addChunk') {
                        if (currentAiDiv) {
                            currentAiDiv.innerText += m.value;
                            document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
                        }
                    }
                    if (m.type === 'showError') {
                        if (thinkingDiv) { thinkingDiv.remove(); thinkingDiv = null; }
                        const errDiv = document.createElement('div');
                        errDiv.className = 'msg error';
                        errDiv.innerText = "❌ " + m.value;
                        document.getElementById('chat').appendChild(errDiv);
                    }
                });

                function send() {
                    const input = document.getElementById('prompt');
                    if(!input.value) return;
                    const userDiv = document.createElement('div');
                    userDiv.className = 'msg user';
                    userDiv.innerText = input.value;
                    document.getElementById('chat').appendChild(userDiv);

                    thinkingDiv = document.createElement('div');
                    thinkingDiv.className = 'thinking';
                    thinkingDiv.innerText = "Pensando en la inmortalidad del cangrejo.....";
                    document.getElementById('chat').appendChild(thinkingDiv);

                    vscode.postMessage({ type: 'askOllama', value: input.value, context: lastContext });
                    input.value = '';
                    document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
                }

                function clearHistory() {
                    document.getElementById('chat').innerHTML = '';
                    vscode.postMessage({ type: 'clearChat' });
                }
            </script>
        </body>
        </html>`;
    }
}