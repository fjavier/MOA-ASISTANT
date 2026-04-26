import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as path from 'path';
import * as fs from 'fs';

export class OllamaChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ollama-chat-view';
    private _view?: vscode.WebviewView;
    private currentIp: string = "";
    private currentModel: string = "";
    private messageHistory: { role: "user" | "assistant", content: string }[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'fetchModels':
                    this.currentIp = data.ip;
                    await this._updateModelsList(data.ip);
                    break;
                case 'disconnect':
                    this.currentIp = "";
                    this._view?.webview.postMessage({ type: 'onDisconnected' });
                    break;
                case 'askOllama':
                    this.currentModel = data.model;
                    this.messageHistory = data.history || []; 
                    await this._handleStreamResponse(data.value);
                    break;
                case 'writeFile':
                    await this._executeWrite(data.code, data.filePath);
                    break;
            }
        });
    }

    private async _executeWrite(code: string, relativePath: string) {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const fullPath = path.join(workspaceFolders[0].uri.fsPath, relativePath.trim());
            const directory = path.dirname(fullPath);
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(fullPath, code, 'utf8');
            this._view?.webview.postMessage({ type: 'fileDone', path: relativePath });
        } catch (err) {}
    }

    private async _handleStreamResponse(prompt: string) {
        if (!this._view || !this.currentIp || !this.currentModel) return;
        try {
            const openai = new OpenAI({
                baseURL: `http://${this.currentIp}:11434/v1`,
                apiKey: 'ollama',
                dangerouslyAllowBrowser: true
            });

            const stream = await openai.chat.completions.create({
                model: this.currentModel,
                messages: [
                    { role: "system", content: "Eres un Agente Programador. Generas archivos con ---FILE: ruta---." },
                    ...this.messageHistory,
                    { role: "user", content: prompt }
                ],
                stream: true,
            });

            let fullText = "";
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                fullText += content;
                this._view.webview.postMessage({ type: 'addChunk', value: fullText });
            }
            this.messageHistory.push({ role: "user", content: prompt }, { role: "assistant", content: fullText });
            this._view.webview.postMessage({ type: 'endResponse', fullText: fullText });
        } catch (err: any) {
            this._view.webview.postMessage({ type: 'showError', value: err.message });
            this._view?.webview.postMessage({ type: 'onDisconnected' });
        }
    }

    private async _updateModelsList(ip: string) {
        try {
            const response = await fetch(`http://${ip}:11434/api/tags`);
            if (!response.ok) throw new Error();
            const data: any = await response.json();
            const models = data.models.map((m: any) => m.name);
            this._view?.webview.postMessage({ type: 'setModels', models });
            this._view?.webview.postMessage({ type: 'onConnected' });
        } catch (e) {
            this._view?.webview.postMessage({ type: 'showError', value: "Error de conexión." });
            this._view?.webview.postMessage({ type: 'onDisconnected' });
        }
    }

    private _getHtmlContent() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
            <style>
                body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; }
                #chat { height: calc(100vh - 210px); overflow-y: auto; margin-bottom: 10px; }
                .msg { margin-bottom: 15px; background: #252526; padding: 10px; border-radius: 5px; border: 1px solid #3e3e42; font-size: 13px; }
                .user-msg { border-left: 3px solid #007acc; background: #1e1e1e; font-weight: 500; }
                .thinking { color: #888; font-style: italic; display: flex; align-items: center; gap: 5px; padding: 5px 0; }
                .dots:after { content: '.'; animation: dots 1.5s steps(5, end) infinite; }
                @keyframes dots { 0%, 20% { content: '.'; } 40% { content: '..'; } 60% { content: '...'; } 80%, 100% { content: ''; } }
                pre { border-radius: 4px; font-size: 12px !important; }
                .file-tag { color: #4ec9b0; font-size: 11px; display: block; margin-top: 8px; font-weight: bold; }
                textarea { width: 100%; background: #3c3c3c; color: white; border: 1px solid #555; padding: 8px; resize: none; box-sizing: border-box; }
                
                button { background: #007acc; color: white; border: none; padding: 8px; cursor: pointer; border-radius: 2px; }
                button:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn-disconnect { background: #a91515 !important; }
                
                .full-btn { width: 100%; margin-top: 5px; }
                .config-section { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 10px; }
                input, select { background: #3c3c3c; color: white; border: 1px solid #555; padding: 5px; }
            </style>
        </head>
        <body>
            <div class="config-section">
                <div style="display:flex; gap:5px;">
                    <input id="ip" type="text" placeholder="IP Ollama">
                    <button id="conn-btn" onclick="toggleConnect()">Conectar</button>
                </div>
                <select id="model-select" onchange="saveState()"></select>
            </div>

            <div id="chat"></div>
            <textarea id="prompt" rows="3" placeholder="Escribe aquí..."></textarea>
            <button class="full-btn" onclick="send()">Enviar</button>

            <script>
                const vscode = acquireVsCodeApi();
                const oldState = vscode.getState() || { html: "", history: [], ip: "", model: "", models: [], isConnected: false };
                let messageHistory = oldState.history;
                let isConnected = oldState.isConnected;
                
                document.getElementById('ip').value = oldState.ip || "";
                document.getElementById('chat').innerHTML = oldState.html || "";
                
                if (oldState.models && oldState.models.length > 0) {
                    renderModels(oldState.models, oldState.model);
                }
                
                // Restaurar UI del botón
                updateButtonUI(isConnected);

                if(oldState.html) Prism.highlightAllUnder(document.getElementById('chat'));
                if(oldState.ip && isConnected) vscode.postMessage({ type: 'fetchModels', ip: oldState.ip });

                let currentAiDiv = null;
                let writtenFiles = new Set();

                window.addEventListener('message', event => {
                    const m = event.data;
                    
                    if (m.type === 'onConnected') {
                        isConnected = true;
                        updateButtonUI(true);
                        saveState();
                    }
                    if (m.type === 'onDisconnected') {
                        isConnected = false;
                        updateButtonUI(false);
                        document.getElementById('model-select').innerHTML = '';
                        saveState();
                    }
                    if (m.type === 'setModels') {
                        renderModels(m.models, vscode.getState()?.model);
                        saveState();
                    }
                    if (m.type === 'addChunk') {
                        currentAiDiv.innerHTML = marked.parse(m.value);
                        Prism.highlightAllUnder(currentAiDiv);
                        detectFiles(m.value);
                        document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
                    }
                    if (m.type === 'endResponse') {
                        messageHistory.push({ role: "assistant", content: m.fullText });
                        saveState();
                    }
                    if (m.type === 'fileDone') {
                        const tag = document.createElement('span');
                        tag.className = 'file-tag';
                        tag.innerText = '✔️ Archivo: ' + m.path;
                        currentAiDiv.appendChild(tag);
                        saveState();
                    }
                    if (m.type === 'showError') {
                        const errDiv = document.createElement('div');
                        errDiv.className = 'msg';
                        errDiv.style.color = '#f48771';
                        errDiv.innerText = "❌ " + m.value;
                        document.getElementById('chat').appendChild(errDiv);
                    }
                });

                function updateButtonUI(connected) {
                    const btn = document.getElementById('conn-btn');
                    const ipInput = document.getElementById('ip');
                    if (connected) {
                        btn.innerText = "Desconectar";
                        btn.classList.add('btn-disconnect');
                        ipInput.disabled = true;
                    } else {
                        btn.innerText = "Conectar";
                        btn.classList.remove('btn-disconnect');
                        ipInput.disabled = false;
                    }
                }

                function toggleConnect() {
                    if (isConnected) {
                        vscode.postMessage({ type: 'disconnect' });
                    } else {
                        const ip = document.getElementById('ip').value;
                        if (!ip) return;
                        document.getElementById('conn-btn').innerText = "Cargando...";
                        vscode.postMessage({ type: 'fetchModels', ip });
                    }
                }

                function renderModels(models, selected) {
                    const select = document.getElementById('model-select');
                    select.innerHTML = models.map(n => \`<option value="\${n}" \${n === selected ? 'selected' : ''}>\${n}</option>\`).join('');
                }

                function saveState() {
                    const select = document.getElementById('model-select');
                    vscode.setState({
                        html: document.getElementById('chat').innerHTML,
                        history: messageHistory,
                        ip: document.getElementById('ip').value,
                        model: select.value,
                        models: Array.from(select.options).map(o => o.value),
                        isConnected: isConnected
                    });
                }

                function detectFiles(text) {
                    const regex = /---FILE:\\s*([\\w\\.\\-\\/]+)\\s*---\\s*[\\r\\n]+\`\`\`(?:\\w+)?\\s*[\\r\\n]+([\\s\\S]*?)\`\`\`/g;
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        const path = match[1];
                        const code = match[2].trim();
                        if (!writtenFiles.has(path) && code.length > 0) {
                            writtenFiles.add(path);
                            vscode.postMessage({ type: 'writeFile', filePath: path, code: code });
                        }
                    }
                }

                function send() {
                    if (!isConnected) {
                        alert("Por favor, conéctate a Ollama primero.");
                        return;
                    }
                    const promptInput = document.getElementById('prompt');
                    const prompt = promptInput.value.trim();
                    const model = document.getElementById('model-select').value;
                    if(!prompt || !model) return;

                    const chat = document.getElementById('chat');
                    const userDiv = document.createElement('div');
                    userDiv.className = 'msg user-msg';
                    userDiv.innerText = "Tú: " + prompt;
                    chat.appendChild(userDiv);

                    currentAiDiv = document.createElement('div');
                    currentAiDiv.className = 'msg';
                    currentAiDiv.innerHTML = '<div class="thinking">Pensando en la inmortalidad del cangrejo<span class="dots"></span></div>';
                    chat.appendChild(currentAiDiv);

                    chat.scrollTop = chat.scrollHeight;

                    messageHistory.push({ role: "user", content: prompt });
                    vscode.postMessage({ type: 'askOllama', value: prompt, model, history: messageHistory });
                    
                    promptInput.value = '';
                    writtenFiles.clear();
                    saveState();
                }
            </script>
        </body>
        </html>`;
    }
}