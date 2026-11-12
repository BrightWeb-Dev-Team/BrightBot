import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import WebSocket from 'ws';
import { bundledVncStatus, startBundledVnc } from './vnc-manager.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const masterUrl = String(process.env.BRIGHTBOT_MASTER_URL || '').replace(/\/$/, '');
const token = String(process.env.BRIGHTBOT_CONTROL_TOKEN || '');
const nodeId = String(process.env.BRIGHTBOT_NODE_ID || os.hostname()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
const nodeName = String(process.env.BRIGHTBOT_NODE_NAME || os.hostname()).slice(0, 100);
const sessions = new Map();
const vncHost = String(process.env.BRIGHTBOT_VNC_HOST || '127.0.0.1');
const vncPort = Number(process.env.BRIGHTBOT_VNC_PORT || 5900);

if (!masterUrl || !token) throw new Error('需要配置 BRIGHTBOT_MASTER_URL 和 BRIGHTBOT_CONTROL_TOKEN');

function systemStatus() {
  const total = os.totalmem();
  const free = os.freemem();
  const cores = os.cpus().length || 1;
  return {
    hostname: os.hostname(), username: os.userInfo().username, platform: `${os.type()} ${os.release()}`, arch: os.arch(), uptime: os.uptime(),
    cpu: Math.min(100, Math.round((os.loadavg()[0] / cores) * 100)), memory: Math.round(((total - free) / total) * 100),
    memoryUsed: total - free, memoryTotal: total, agentVersion: '1.1.0', remoteNode: true,
  };
}

function openVncTunnel(sessionId) {
  return new Promise((resolve, reject) => {
    const url = new URL(masterUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/node/vnc';
    url.search = new URLSearchParams({ nodeId, sessionId }).toString();
    const webSocket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      perMessageDeflate: false,
    });
    let settled = false;
    webSocket.once('open', () => {
      const target = net.createConnection({ host: vncHost, port: vncPort });
      target.setNoDelay(true);
      target.once('connect', () => { settled = true; webSocket._socket?.setNoDelay(true); resolve({ connected: true }); });
      target.on('data', (chunk) => {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (webSocket.bufferedAmount > 1024 * 1024) target.pause();
        webSocket.send(chunk, { binary: true, compress: false }, () => target.resume());
      });
      webSocket.on('message', (data) => target.writable && target.write(Buffer.from(data)));
      target.on('error', (error) => { if (!settled) reject(error); webSocket.close(1011, 'VNC service unavailable'); });
      target.on('close', () => webSocket.close());
      webSocket.on('close', () => target.destroy());
      webSocket.on('error', () => target.destroy());
    });
    webSocket.once('error', (error) => { if (!settled) reject(error); });
  });
}

async function captureScreen() {
  const file = path.join(os.tmpdir(), `brightbot-${Date.now()}.png`);
  if (process.platform === 'darwin') await execFileAsync('screencapture', ['-x', file], { timeout: 15_000 });
  else await execFileAsync('gnome-screenshot', ['-f', file], { timeout: 15_000 });
  const bytes = await fs.readFile(file);
  await fs.unlink(file).catch(() => {});
  return { message: '已抓取远程桌面', image: `data:image/png;base64,${bytes.toString('base64')}`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function shell(command, cwd = os.homedir()) {
  return new Promise((resolve) => exec(command, { cwd, shell: process.env.SHELL || '/bin/sh', timeout: 20_000, maxBuffer: 1024 * 1024 },
    (error, stdout = '', stderr = '') => resolve({ ok: !error, output: `${stdout}${stderr}`.trimEnd(), exitCode: error?.code ?? 0 })));
}

function normalizeHotkey(value) {
  const parts = String(value).toLowerCase().split('+').map((item) => item.trim()).filter(Boolean);
  const aliases = { cmd: 'command', command: 'command', ctrl: 'control', option: 'option', alt: 'option', shift: 'shift' };
  const modifiers = parts.slice(0, -1).map((item) => aliases[item]).filter(Boolean);
  const key = parts.at(-1) || '';
  if (!/^[a-z0-9 ]$/.test(key) && !['enter', 'tab', 'escape', 'space', 'left', 'right', 'up', 'down'].includes(key)) throw new Error('快捷键格式无效');
  return { modifiers, key };
}

async function desktopSize() {
  const { stdout } = await execFileAsync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
  const values = stdout.trim().split(',').map((value) => Number(value.trim()));
  return { width: values[2] - values[0], height: values[3] - values[1] };
}

async function computerInput(action) {
  if (process.platform !== 'darwin') throw new Error('远程桌面输入当前需要 macOS 节点');
  const logical = await desktopSize();
  const imageWidth = Number(action.imageWidth) || logical.width;
  const imageHeight = Number(action.imageHeight) || logical.height;
  const x = Math.max(0, Math.min(logical.width - 1, Number(action.x) * logical.width / imageWidth));
  const y = Math.max(0, Math.min(logical.height - 1, Number(action.y) * logical.height / imageHeight));
  const args = [path.join(__dirname, 'macos-input.py'), action.type, String(x), String(y)];
  if (action.type === 'scroll') args.push(String(Number(action.deltaY) || -500));
  await execFileAsync('python3', args, { timeout: 15_000 });
  return { message: `已执行 ${action.type}` };
}

async function executeAction(action) {
  switch (action.type) {
    case 'status': return systemStatus();
    case 'shell': return { message: '远程命令执行完成', ...(await shell(String(action.command || ''))) };
    case 'screenshot': return captureScreen();
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
    case 'scroll': return computerInput(action);
    case 'type_text':
      if (process.platform !== 'darwin') throw new Error('文字输入当前需要 macOS 节点');
      await execFileAsync('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to item 1 of argv', '-e', 'tell application "System Events" to keystroke "v" using command down', '-e', 'end run', String(action.text || '')]);
      return { message: `已输入 ${String(action.text || '').length} 个字符` };
    case 'hotkey': {
      if (process.platform !== 'darwin') throw new Error('快捷键当前需要 macOS 节点');
      const { modifiers, key } = normalizeHotkey(action.keys);
      const specialCodes = { enter: 36, tab: 48, escape: 53, space: 49, left: 123, right: 124, down: 125, up: 126 };
      const using = modifiers.length ? ` using {${modifiers.map((item) => `${item} down`).join(', ')}}` : '';
      const script = specialCodes[key] !== undefined ? `tell application "System Events" to key code ${specialCodes[key]}${using}` : `tell application "System Events" to keystroke "${key}"${using}`;
      await execFileAsync('osascript', ['-e', script]);
      return { message: `已执行快捷键 ${action.keys}` };
    }
    case 'open_url':
      await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [new URL(action.target).toString()], { timeout: 15_000 });
      return { message: `已打开 ${action.target}` };
    case 'open_app':
      await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'darwin' ? ['-a', String(action.target)] : [String(action.target)], { timeout: 15_000 });
      return { message: `已启动 ${action.target}` };
    case 'lock':
      await execFileAsync(process.platform === 'darwin' ? 'pmset' : 'loginctl', process.platform === 'darwin' ? ['displaysleepnow'] : ['lock-session']);
      return { message: '锁屏指令已执行' };
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(100, Number(action.ms) || 1000))));
      return { message: '等待完成' };
    default: throw new Error(`远程节点暂未配置操作类型: ${action.type}`);
  }
}

async function executeTerminal(payload) {
  const id = String(payload.sessionId || 'default');
  const cwd = sessions.get(id) || os.homedir();
  const marker = `__BRIGHTBOT_CWD_${Date.now()}__`;
  const result = await shell(`${payload.command}\nprintf '\n${marker}%s\n' "$PWD"`, cwd);
  const index = result.output.lastIndexOf(marker);
  const output = index >= 0 ? result.output.slice(0, index).trimEnd() : result.output;
  const nextCwd = index >= 0 ? result.output.slice(index + marker.length).trim() : cwd;
  sessions.set(id, path.isAbsolute(nextCwd) ? nextCwd : cwd);
  return { ...result, output, cwd: sessions.get(id), cwdLabel: sessions.get(id) };
}

async function request(endpoint, body) {
  const response = await fetch(`${masterUrl}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nodeId, name: nodeName, status: systemStatus(), ...body }), signal: AbortSignal.timeout(35_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `主控端返回 ${response.status}`);
  return data;
}

async function main() {
  console.log(`[BrightBot Node] ${nodeName} (${nodeId}) -> ${masterUrl}`);
  for (;;) {
    try {
      const { jobs = [], pollAfterMs = 1500 } = await request('/api/node/poll', {});
      for (const job of jobs) {
        try {
          const result = job.type === 'status' ? systemStatus()
            : job.type === 'terminal' ? await executeTerminal(job.payload)
              : job.type === 'vnc-status' ? await bundledVncStatus({ host: vncHost, port: vncPort })
                : job.type === 'vnc-start' ? (await startBundledVnc({ host: vncHost, port: vncPort }), await bundledVncStatus({ host: vncHost, port: vncPort }))
                  : job.type === 'vnc-tunnel' ? await openVncTunnel(String(job.payload.sessionId || ''))
                    : await executeAction(job.payload);
          await request('/api/node/result', { jobId: job.id, ok: true, result });
        } catch (error) {
          await request('/api/node/result', { jobId: job.id, ok: false, error: error.message }).catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollAfterMs));
    } catch (error) {
      console.error(`[BrightBot Node] ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main();
