import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(rootDir, 'data', 'vnc');
const archNames = { x64: 'x64', arm64: 'arm64' };
let child = null;
let lastError = '';

function bundledBinary(name) {
  const arch = archNames[process.arch] || process.arch;
  const candidates = [
    path.join(rootDir, 'vendor', 'vnc', `linux-${arch}`, 'usr', 'bin', name),
    path.join(rootDir, 'vendor', 'vnc', `linux-${arch}`, 'bin', name),
    path.join(rootDir, 'vendor', 'vnc', 'bin', name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

export function bundledVncInfo() {
  const binary = process.platform === 'linux' ? bundledBinary('x11vnc') : '';
  return { supported: process.platform === 'linux', installed: Boolean(binary), binary };
}

export function checkVncPort(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function libraryPath(binary) {
  const prefix = path.resolve(path.dirname(binary), '..');
  const directories = [
    path.join(prefix, 'lib'),
    path.join(prefix, 'lib64'),
    path.join(prefix, 'lib', 'x86_64-linux-gnu'),
    path.join(prefix, 'lib', 'aarch64-linux-gnu'),
  ].filter((directory) => fs.existsSync(directory));
  return [directories.join(':'), process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
}

export async function startBundledVnc({ host = '127.0.0.1', port = 5900 } = {}) {
  if (process.platform !== 'linux') return { started: false, reason: 'platform' };
  if (await checkVncPort(host, port)) return { started: false, reason: 'already-running' };
  if (String(process.env.BRIGHTBOT_VNC_AUTO_START || 'true').toLowerCase() === 'false') return { started: false, reason: 'disabled' };
  const binary = bundledBinary('x11vnc');
  if (!binary) {
    lastError = '项目内尚未安装 x11vnc，请执行 npm run vnc:install';
    return { started: false, reason: 'not-installed', error: lastError };
  }
  const display = String(process.env.BRIGHTBOT_VNC_DISPLAY || process.env.DISPLAY || ':0');
  const password = String(process.env.BRIGHTBOT_VNC_PASSWORD || '');
  await fs.promises.mkdir(runtimeDir, { recursive: true });
  const args = [
    '-display', display,
    '-rfbport', String(port),
    '-listen', host,
    '-forever',
    '-shared',
    '-noxdamage',
    '-repeat',
    '-wait', '10',
    '-defer', '10',
  ];
  const xAuthority = String(process.env.BRIGHTBOT_VNC_XAUTHORITY || process.env.XAUTHORITY || '');
  if (xAuthority) args.push('-auth', xAuthority);
  else args.push('-auth', 'guess');
  if (password) {
    const passwordFile = path.join(runtimeDir, 'passwd');
    const stored = spawn(binary, ['-storepasswd', password, passwordFile], {
      stdio: 'ignore',
      env: { ...process.env, LD_LIBRARY_PATH: libraryPath(binary) },
    });
    await new Promise((resolve, reject) => {
      stored.once('error', reject);
      stored.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`VNC 密码文件生成失败 (${code})`)));
    });
    await fs.promises.chmod(passwordFile, 0o600);
    args.push('-rfbauth', passwordFile);
  } else args.push('-nopw');
  const logFile = fs.openSync(path.join(runtimeDir, 'x11vnc.log'), 'a');
  child = spawn(binary, args, {
    detached: false,
    stdio: ['ignore', logFile, logFile],
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath(binary) },
  });
  child.once('error', (error) => { lastError = error.message; child = null; });
  child.once('exit', (code, signal) => {
    if (code && code !== 0) lastError = `x11vnc 已退出 (${code}${signal ? `, ${signal}` : ''})`;
    child = null;
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const available = await checkVncPort(host, port);
  if (!available && !lastError) lastError = `x11vnc 未连接到显示会话 ${display}，请检查 DISPLAY/XAUTHORITY 或切换到 X11 会话`;
  return { started: available, reason: available ? 'started' : 'start-failed', error: available ? '' : lastError };
}

export function stopBundledVnc() {
  if (!child) return false;
  child.kill('SIGTERM');
  child = null;
  return true;
}

export async function bundledVncStatus({ host = '127.0.0.1', port = 5900 } = {}) {
  const info = bundledVncInfo();
  return { ...info, available: await checkVncPort(host, port), managed: Boolean(child), error: lastError };
}

