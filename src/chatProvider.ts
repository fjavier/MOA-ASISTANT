import * as vscode from "vscode";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  html: string;
}

export class OllamaChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollama-chat-view";

  private _view?: vscode.WebviewView;
  private currentIp = "";
  private currentModel = "";

  private sessions: ChatSession[] = [];
  private currentChatId = "";

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.createNewChat();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "newChat":
          this.createNewChat();
          this.refreshTabs();
          this.loadCurrentChat();
          break;

        case "switchChat":
          this.currentChatId = data.id;
          this.loadCurrentChat();
          break;

        case "closeChat":
          this.closeChat(data.id);
          break;

        case "fetchModels":
          this.currentIp = data.ip;
          await this.updateModels(data.ip);
          break;

        case "disconnect":
          this.currentIp = "";
          this._view?.webview.postMessage({
            type: "onDisconnected"
          });
          break;

        case "askOllama":
          this.currentModel = data.model;
          await this.ask(data.value);
          break;

        case "writeFile":
          await this.writeFile(data.code, data.filePath);
          break;
      }
    });

    this.refreshTabs();
    this.loadCurrentChat();
  }

  private createNewChat() {
    const id = Date.now().toString();

    this.sessions.push({
      id,
      title: "Nuevo Chat",
      messages: [],
      html: ""
    });

    this.currentChatId = id;
  }

  private closeChat(id: string) {
    this.sessions = this.sessions.filter(x => x.id !== id);

    if (this.sessions.length === 0) {
      this.createNewChat();
    }

    if (this.currentChatId === id) {
      this.currentChatId = this.sessions[0].id;
    }

    this.refreshTabs();
    this.loadCurrentChat();
  }

  private getCurrentChat(): ChatSession {
    return this.sessions.find(x => x.id === this.currentChatId)!;
  }

  private refreshTabs() {
    this._view?.webview.postMessage({
      type: "renderTabs",
      tabs: this.sessions,
      selected: this.currentChatId
    });
  }

  private loadCurrentChat() {
    const chat = this.getCurrentChat();

    this._view?.webview.postMessage({
      type: "loadChat",
      html: chat.html,
      title: chat.title
    });

    this.refreshTabs();
  }

  private async writeFile(code: string, relativePath: string) {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) return;

      const fullPath = path.join(
        folders[0].uri.fsPath,
        relativePath.trim()
      );

      const dir = path.dirname(fullPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, code, "utf8");

      this._view?.webview.postMessage({
        type: "fileDone",
        path: relativePath
      });

    } catch {}
  }

  private async ask(prompt: string) {
    if (!this.currentIp || !this.currentModel || !this._view) return;

    const chat = this.getCurrentChat();

    try {
      const openai = new OpenAI({
        baseURL: `http://${this.currentIp}:11434/v1`,
        apiKey: "ollama",
        dangerouslyAllowBrowser: true
      });

      const stream = await openai.chat.completions.create({
        model: this.currentModel,
        messages: [
          {
            role: "system",
            content:
              "Eres un agente programador experto. Si creas archivos usa ---FILE:ruta---"
          },
          ...chat.messages,
          {
            role: "user",
            content: prompt
          }
        ],
        stream: true
      });

      let fullText = "";

      for await (const chunk of stream) {
        const txt = chunk.choices[0]?.delta?.content || "";
        fullText += txt;

        this._view.webview.postMessage({
          type: "addChunk",
          value: fullText
        });
      }

      chat.messages.push(
        { role: "user", content: prompt },
        { role: "assistant", content: fullText }
      );

      if (chat.messages.length === 2) {
        chat.title = prompt.substring(0, 20);
      }

      chat.html += `
<div class="row userRow">
  <div class="bubble userBubble">${this.escapeHtml(prompt)}</div>
</div>

<div class="row aiRow">
  <div class="bubble aiBubble">${fullText}</div>
</div>
`;

      this._view.webview.postMessage({
        type: "endResponse"
      });

      this.refreshTabs();

    } catch (err: any) {
      this._view.webview.postMessage({
        type: "showError",
        value: err.message
      });
    }
  }

  private escapeHtml(text: string) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private async updateModels(ip: string) {
    try {
      const res = await fetch(`http://${ip}:11434/api/tags`);
      const data: any = await res.json();

      const models = data.models.map((m: any) => m.name);

      this._view?.webview.postMessage({
        type: "setModels",
        models
      });

      this._view?.webview.postMessage({
        type: "onConnected"
      });

    } catch {
      this._view?.webview.postMessage({
        type: "showError",
        value: "No se pudo conectar"
      });
    }
  }

  private getHtml() {
    return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>

<style>

:root{
--bg:#0d1117;
--panel:#161b22;
--panel2:#11161c;
--border:#30363d;
--text:#e6edf3;
--muted:#8b949e;
--accent:#2383e2;
--accent2:#1f6feb;
--bubble:#1b222c;
--success:#238636;
}

*{
margin:0;
padding:0;
box-sizing:border-box;
}

html,body{
height:100%;
overflow:hidden;
font-family:Segoe UI,Arial,sans-serif;
background:var(--bg);
color:var(--text);
}

body{
display:flex;
flex-direction:column;
}

/* HEADER PROFESIONAL */

#topbar{
padding:12px 14px;
display:flex;
flex-direction:column;
gap:10px;
background:#0f141a;
border-bottom:1px solid var(--border);
}

.top-row,
.bottom-row{
display:flex;
align-items:center;
gap:10px;
}

.top-row{
justify-content:space-between;
}

.brand{
font-size:12px;
font-weight:700;
letter-spacing:.5px;
white-space:nowrap;
}

.statusWrap{
display:flex;
align-items:center;
gap:8px;
font-size:12px;
color:var(--muted);
}

#status{
width:9px;
height:9px;
border-radius:50%;
background:#666;
}

.connected{
background:var(--success)!important;
box-shadow:0 0 8px rgba(35,134,54,.6);
}

#ip{
flex:1;
min-width:0;
}

#ip,#model{
height:38px;
padding:0 12px;
border-radius:10px;
border:1px solid var(--border);
background:#11161c;
color:white;
outline:none;
}

#model{
min-width:180px;
}

#connectBtn{
height:38px;
padding:0 16px;
border:none;
border-radius:10px;
background:linear-gradient(180deg,var(--accent),var(--accent2));
color:white;
font-weight:600;
cursor:pointer;
}

#connectBtn:hover{
filter:brightness(1.08);
}

/* TABS */

#tabs{
height:52px;
display:flex;
align-items:center;
gap:8px;
padding:0 10px;
overflow-x:auto;
border-bottom:1px solid var(--border);
background:var(--panel);
}

#newTab{
min-width:34px;
height:34px;
border:none;
border-radius:10px;
background:linear-gradient(180deg,var(--accent),var(--accent2));
color:white;
font-size:18px;
cursor:pointer;
}

#tabList{
display:flex;
gap:8px;
}

.tab{
display:flex;
align-items:center;
gap:8px;
padding:8px 12px;
background:#11161c;
border:1px solid var(--border);
border-radius:10px;
font-size:12px;
white-space:nowrap;
cursor:pointer;
}

.tab.active{
background:#1a2940;
border-color:#29598a;
}

.close{
opacity:.7;
cursor:pointer;
}

/* CHAT */

#chatWrap{
flex:1;
overflow:auto;
padding:24px;
display:flex;
justify-content:center;
}

#chatArea{
width:100%;
max-width:920px;
display:flex;
flex-direction:column;
gap:16px;
}

#chatTitle{
text-align:center;
color:var(--muted);
font-size:13px;
margin-bottom:10px;
}

.row{
display:flex;
}

.userRow{
justify-content:flex-end;
}

.aiRow{
justify-content:flex-start;
}

.bubble{
max-width:78%;
padding:14px 16px;
border-radius:16px;
line-height:1.55;
font-size:14px;
word-break:break-word;
}

.userBubble{
background:linear-gradient(180deg,#2563eb,#1d4ed8);
color:white;
}

.aiBubble{
background:var(--bubble);
border:1px solid #28303a;
}

.aiBubble pre{
background:#0b0f14;
padding:14px;
border-radius:12px;
overflow:auto;
margin-top:10px;
}

/* COMPOSER */

#composer{
padding:14px;
border-top:1px solid var(--border);
background:var(--panel);
}

#inputWrap{
max-width:920px;
margin:auto;
display:flex;
gap:10px;
background:#0f141a;
border:1px solid var(--border);
border-radius:16px;
padding:10px;
}

#prompt{
flex:1;
border:none;
outline:none;
resize:none;
background:transparent;
color:white;
font-size:14px;
min-height:24px;
max-height:180px;
}

#send{
width:42px;
height:42px;
border:none;
border-radius:12px;
background:linear-gradient(180deg,var(--accent),var(--accent2));
color:white;
cursor:pointer;
font-size:18px;
}

#hint{
max-width:920px;
margin:8px auto 0;
font-size:12px;
color:var(--muted);
}

::-webkit-scrollbar{
height:8px;
width:8px;
}

::-webkit-scrollbar-thumb{
background:#30363d;
border-radius:20px;
}

</style>
</head>

<body>

<div id="topbar">

<div class="top-row">
<div class="brand">OLLAMA DEV · CHAT CODER</div>

<div class="statusWrap">
<div id="status"></div>
<span id="statusText">Offline</span>
</div>
</div>

<div class="bottom-row">
<input id="ip" placeholder="192.168.x.x">
<button id="connectBtn" onclick="connect()">Conectar</button>
<select id="model"></select>
</div>

</div>

<div id="tabs">
<button id="newTab" onclick="newChat()">+</button>
<div id="tabList"></div>
</div>

<div id="chatWrap">
<div id="chatArea">
<div id="chatTitle"></div>
<div id="chat"></div>
</div>
</div>

<div id="composer">
<div id="inputWrap">
<textarea id="prompt" rows="1"
placeholder="Ask anything about your code..."></textarea>
<button id="send" onclick="send()">➜</button>
</div>
<div id="hint">Enter enviar · Shift + Enter salto</div>
</div>

<script>

const vscode = acquireVsCodeApi();
let currentAi = null;

window.addEventListener('message', e => {

const m = e.data;

if(m.type === 'renderTabs'){
renderTabs(m.tabs,m.selected);
}

if(m.type === 'loadChat'){
document.getElementById('chat').innerHTML = m.html || '';
document.getElementById('chatTitle').innerText = m.title || '';
scrollBottom();
}

if(m.type === 'setModels'){
document.getElementById('model').innerHTML =
m.models.map(x => '<option>'+x+'</option>').join('');
}

if(m.type === 'onConnected'){
document.getElementById('status').classList.add('connected');
document.getElementById('statusText').innerText='Connected';
}

if(m.type === 'onDisconnected'){
document.getElementById('status').classList.remove('connected');
document.getElementById('statusText').innerText='Offline';
}

if(m.type === 'addChunk'){
currentAi.innerHTML = marked.parse(m.value);
scrollBottom();
}

if(m.type === 'showError'){
alert(m.value);
}

});

function renderTabs(tabs,selected){

document.getElementById('tabList').innerHTML =
tabs.map(t => \`
<div class="tab \${t.id===selected?'active':''}">
<span onclick="switchChat('\${t.id}')">💬 \${escapeHtml(t.title)}</span>
<span class="close"
onclick="event.stopPropagation();closeChat('\${t.id}')">✕</span>
</div>\`).join('');
}

function newChat(){
vscode.postMessage({type:'newChat'});
}

function switchChat(id){
vscode.postMessage({type:'switchChat',id});
}

function closeChat(id){
vscode.postMessage({type:'closeChat',id});
}

function connect(){
vscode.postMessage({
type:'fetchModels',
ip:document.getElementById('ip').value
});
}

function send(){

const prompt =
document.getElementById('prompt').value.trim();

if(!prompt) return;

const chat = document.getElementById('chat');

const userRow = document.createElement('div');
userRow.className='row userRow';

const userBubble = document.createElement('div');
userBubble.className='bubble userBubble';
userBubble.innerText=prompt;

userRow.appendChild(userBubble);
chat.appendChild(userRow);

const aiRow = document.createElement('div');
aiRow.className='row aiRow';

currentAi = document.createElement('div');
currentAi.className='bubble aiBubble';
currentAi.innerHTML='Thinking...';

aiRow.appendChild(currentAi);
chat.appendChild(aiRow);

scrollBottom();

vscode.postMessage({
type:'askOllama',
value:prompt,
model:document.getElementById('model').value
});

document.getElementById('prompt').value='';
autoGrow();
}

function autoGrow(){
const el=document.getElementById('prompt');
el.style.height='24px';
el.style.height=el.scrollHeight+'px';
}

function scrollBottom(){
const c=document.getElementById('chatWrap');
c.scrollTop=c.scrollHeight;
}

document.getElementById('prompt')
.addEventListener('input',autoGrow);

document.getElementById('prompt')
.addEventListener('keydown',e=>{
if(e.key==='Enter' && !e.shiftKey){
e.preventDefault();
send();
}
});

function escapeHtml(str){
return str
.replaceAll('&','&amp;')
.replaceAll('<','&lt;')
.replaceAll('>','&gt;');
}

</script>

</body>
</html>
`;
  }
}