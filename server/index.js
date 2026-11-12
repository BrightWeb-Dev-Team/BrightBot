import { wechatRequest, buildWechatText, wechatBaseInfo } from './wechat-client.js';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import * as Lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import net from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WebSocketServer } from 'ws';
import { bundledVncStatus, startBundledVnc, stopBundledVnc } from './vnc-manager.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const settingsFile = path.join(dataDir, 'settings.json');
const conversationsFile = path.join(dataDir, 'conversations.json');
const runtimeLogFile = path.join(dataDir, 'runtime.ndjson');
const skillsFile = path.join(dataDir, 'skills.json');
const scheduledTasksFile = path.join(dataDir, 'scheduled-tasks.json');
const screenshotDir = path.join(dataDir, 'screenshots');
const port = Number(process.env.PORT || 8787);
const listenHost = process.env.HOST || '127.0.0.1';
const defaultSystemPrompt = '你是 BrightBot，一个简洁、可靠的本机智能助手。请使用中文回答，除非用户要求使用其他语言。';
const authSessionMaxAge = 7 * 24 * 60 * 60 * 1000;
const vncHost = String(process.env.BRIGHTBOT_VNC_HOST || '127.0.0.1');
const vncPort = Number(process.env.BRIGHTBOT_VNC_PORT || 5900);

const app = express();
app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] }));
app.use(express.json({ limit: '15mb' }));

const defaultSettings = {
  llmProviderName: process.env.LLM_PROVIDER_NAME || '自定义提供商',
  llmBaseUrl: process.env.LLM_BASE_URL || '',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  systemPrompt: process.env.SYSTEM_PROMPT || defaultSystemPrompt,
  mbti: process.env.AGENT_MBTI || 'INTJ',
  qqAppId: process.env.QQBOT_APP_ID || '',
  qqAppSecret: process.env.QQBOT_APP_SECRET || '',
  qqAllowedOpenids: process.env.QQBOT_ALLOWED_OPENIDS || '',
  wechatToken: process.env.WECHAT_ILINK_TOKEN || '',
  wechatAccountId: process.env.WECHAT_ILINK_ACCOUNT_ID || '',
  wechatBaseUrl: process.env.WECHAT_ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com',
  wechatSyncBuf: '',
  wechatContextTokens: {},
  wechatProcessedMessageIds: [],
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
  feishuDomain: process.env.FEISHU_DOMAIN || 'https://open.feishu.cn',
  feishuProcessedMessageIds: [],
  authUsername: process.env.BRIGHTBOT_USERNAME || 'admin',
  authPasswordHash: '',
  authInitialized: false,
  brightwebIssuer: process.env.BRIGHTWEB_ISSUER || 'https://auth.brightweb.top/oidc',
  brightwebClientId: process.env.BRIGHTWEB_CLIENT_ID || '',
  brightwebClientSecret: process.env.BRIGHTWEB_CLIENT_SECRET || '',
  brightwebRedirectUri: process.env.BRIGHTWEB_REDIRECT_URI || '',
  brightwebAllowedUsers: process.env.BRIGHTWEB_ALLOWED_USERS || '',
  botProfiles: [],
  activeBotProfiles: {},
  conversationNodeTargets: {},
  controlToken: String(process.env.BRIGHTBOT_CONTROL_TOKEN || '').trim(),
  masterPublicUrl: String(process.env.BRIGHTBOT_MASTER_URL || '').trim(),
};

let settings = { ...defaultSettings };
let logs = [];
let skills = [];
let scheduledTasks = [];
let schedulerTimer = null;
const runningScheduledTasks = new Set();
const eventClients = new Set();
const qqRuntimes = new Map();
const wechatRuntimes = new Map();
const feishuRuntimes = new Map();
const conversationMemory = new Map();
let applicationCache = { expiresAt: 0, names: [] };
const terminalSessions = new Map();
const remoteNodes = new Map();
const remoteJobs = new Map();
const agentRuns = new Map();
let conversationSaveTimer = null;
let logWriteQueue = Promise.resolve();
const authSessions = new Map();
const vncTickets = new Map();
const remoteVncSessions = new Map();
const oidcAttempts = new Map();
const brightwebJwks = createRemoteJWKSet(new URL('https://auth.brightweb.top/oidc/jwks'));

function scryptPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scryptPassword(password, salt);
  const actualKey = Buffer.from(actual.split(':')[1], 'hex');
  const expectedKey = Buffer.from(expectedHex, 'hex');
  return actualKey.length === expectedKey.length && crypto.timingSafeEqual(actualKey, expectedKey);
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return index < 0 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
  }));
}

function currentAuthSession(req) {
  const token = cookies(req).brightbot_session;
  const session = token ? authSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) authSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`).split(',')[0].trim();
  return `${protocol}://${host}`;
}

function brightwebRedirectUri(req) {
  return String(settings.brightwebRedirectUri || '').trim() || `${requestOrigin(req)}/api/auth/brightweb/callback`;
}

function setAuthCookie(req, res, token, maxAge = authSessionMaxAge) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `brightbot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge / 1000)}${secure}`);
}

function createAuthSession(req, res, profile) {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, { ...profile, expiresAt: Date.now() + authSessionMaxAge });
  setAuthCookie(req, res, token);
  return token;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function brightwebUserAllowed(profile) {
  const allowed = String(settings.brightwebAllowedUsers || '').split(/[\n,]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return false;
  const identities = [profile.sub, profile.email, profile.preferred_username, profile.username].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  return identities.some((identity) => allowed.includes(identity));
}

async function bootstrap() {
  await fs.mkdir(screenshotDir, { recursive: true });
  try {
    const content = await fs.readFile(runtimeLogFile, 'utf8');
    logs = content.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).slice(-500).reverse();
  } catch {
    // Runtime log file is created by the first event.
  }
  try {
    const savedSkills = JSON.parse(await fs.readFile(skillsFile, 'utf8'));
    if (Array.isArray(savedSkills)) skills = savedSkills;
  } catch {
    // Skills start empty on first run.
  }
  try {
    const savedTasks = JSON.parse(await fs.readFile(scheduledTasksFile, 'utf8'));
    if (Array.isArray(savedTasks)) scheduledTasks = savedTasks;
  } catch {
    // Scheduled tasks start empty on first run.
  }
  try {
    settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) };
  } catch {
    // First run uses environment defaults.
  }
  if (settings.authPasswordHash && settings.authInitialized !== true) {
    settings.authInitialized = true;
    await saveSettings();
  }
  migrateBotProfiles();
  await saveSettings();
  try {
    const saved = JSON.parse(await fs.readFile(conversationsFile, 'utf8'));
    for (const [key, history] of Object.entries(saved)) {
      if (Array.isArray(history)) conversationMemory.set(key, history.slice(-20));
    }
  } catch {
    // Conversation memory starts empty on first run.
  }
}

async function saveSkills() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(skillsFile, JSON.stringify(skills, null, 2));
}

async function saveScheduledTasks() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(scheduledTasksFile, JSON.stringify(scheduledTasks, null, 2));
}

function nextDailyRun(time, from = new Date()) {
  const [hour, minute] = String(time || '').split(':').map(Number);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('每日执行时间无效');
  }
  const chinaNow = new Date(from.getTime() + 8 * 60 * 60 * 1000);
  const year = chinaNow.getUTCFullYear();
  const month = chinaNow.getUTCMonth();
  const day = chinaNow.getUTCDate();
  let next = new Date(Date.UTC(year, month, day, hour - 8, minute, 0, 0));
  if (next <= from) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next.toISOString();
}

function calculateNextRun(task, from = new Date()) {
  if (!task.enabled) return null;
  if (task.scheduleType === 'once') {
    const runAt = new Date(task.runAt);
    return Number.isNaN(runAt.getTime()) || runAt <= from ? null : runAt.toISOString();
  }
  if (task.scheduleType === 'daily') return nextDailyRun(task.dailyTime, from);
  const minutes = Number(task.intervalMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525600) throw new Error('执行间隔需要在 1 到 525600 分钟之间');
  return new Date(from.getTime() + minutes * 60 * 1000).toISOString();
}

function normalizeScheduledTask(input, current = {}) {
  const scheduleType = ['once', 'daily', 'interval'].includes(input.scheduleType) ? input.scheduleType : (current.scheduleType || 'once');
  const contentType = input.contentType === undefined ? (current.contentType || 'message') : (input.contentType === 'agent' ? 'agent' : 'message');
  const channel = ['qq', 'wechat', 'feishu'].includes(input.channel) ? input.channel : current.channel;
  const name = String(input.name ?? current.name ?? '').trim().slice(0, 100);
  const content = String(input.content ?? current.content ?? '').trim().slice(0, 8000);
  const target = String(input.target ?? current.target ?? '').trim().slice(0, 300);
  if (!name) throw new Error('任务名称不能为空');
  if (!content) throw new Error('任务内容不能为空');
  if (!channel) throw new Error('请选择推送通道');
  if (!target) throw new Error('推送目标不能为空');
  const task = {
    ...current,
    id: current.id || crypto.randomUUID(),
    name,
    content,
    contentType,
    channel,
    target,
    qqMessageType: input.qqMessageType === undefined ? (current.qqMessageType || 'private') : (input.qqMessageType === 'group' ? 'group' : 'private'),
    scheduleType,
    runAt: String(input.runAt ?? current.runAt ?? ''),
    dailyTime: String(input.dailyTime ?? current.dailyTime ?? '09:00'),
    intervalMinutes: Number(input.intervalMinutes ?? current.intervalMinutes ?? 60),
    enabled: input.enabled === undefined ? (current.enabled ?? true) : Boolean(input.enabled),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (scheduleType === 'once') {
    const runAt = new Date(task.runAt);
    if (Number.isNaN(runAt.getTime()) || (task.enabled && runAt <= new Date())) throw new Error('启用的单次任务执行时间需要晚于当前时间');
    task.runAt = runAt.toISOString();
  }
  task.nextRunAt = calculateNextRun(task);
  return task;
}

async function pushScheduledMessage(task, text) {
  if (task.channel === 'qq') return sendQQ({ messageType: task.qqMessageType, target: task.target, message: text });
  if (task.channel === 'wechat') return sendWechatText(task.target, text);
  return sendFeishuText(task.target, text);
}

async function executeScheduledTask(task, manual = false) {
  if (runningScheduledTasks.has(task.id)) throw new Error('任务正在执行中');
  runningScheduledTasks.add(task.id);
  const startedAt = new Date();
  try {
    const text = task.contentType === 'agent'
      ? (await handleAgentMessage(task.content, 'scheduler', task.id)).reply
      : task.content;
    await pushScheduledMessage(task, text);
    task.lastRunAt = startedAt.toISOString();
    task.lastStatus = 'success';
    task.lastResult = String(text).slice(0, 500);
    task.lastError = '';
    addLog('success', manual ? '定时任务已立即执行' : '后台定时任务执行成功', `${task.name} · ${task.channel}`);
  } catch (error) {
    task.lastRunAt = startedAt.toISOString();
    task.lastStatus = 'error';
    task.lastError = String(error.message || error).slice(0, 1000);
    addLog('error', '后台定时任务执行失败', `${task.name} · ${task.lastError}`);
    if (manual) throw error;
  } finally {
    if (!manual) {
      if (task.scheduleType === 'once') task.enabled = false;
      task.nextRunAt = calculateNextRun(task, startedAt);
    }
    task.updatedAt = new Date().toISOString();
    runningScheduledTasks.delete(task.id);
    await saveScheduledTasks();
  }
  return task;
}

async function schedulerTick() {
  const now = Date.now();
  const due = scheduledTasks.filter((task) => task.enabled && task.nextRunAt && new Date(task.nextRunAt).getTime() <= now);
  await Promise.allSettled(due.map((task) => executeScheduledTask(task)));
}

function startScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => schedulerTick().catch((error) => addLog('error', '任务调度器异常', error.message)), 15_000);
  schedulerTick().catch((error) => addLog('error', '任务调度器启动失败', error.message));
}

function normalizeSkill(input, current = {}) {
  const name = String(input.name ?? current.name ?? '').trim().slice(0, 80);
  const instructions = String(input.instructions ?? current.instructions ?? '').trim().slice(0, 8000);
  if (!name) throw new Error('Skill 名称不能为空');
  if (!instructions) throw new Error('Skill 执行指令不能为空');
  return {
    id: current.id || crypto.randomUUID(),
    name,
    description: String(input.description ?? current.description ?? '').trim().slice(0, 300),
    trigger: String(input.trigger ?? current.trigger ?? '').trim().slice(0, 300),
    instructions,
    enabled: input.enabled === undefined ? (current.enabled ?? true) : Boolean(input.enabled),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function parseSkillMarkdown(content, filename = 'Skill.md') {
  let markdown = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!markdown) throw new Error('Markdown 文件内容为空');
  const metadata = {};
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (frontmatter) {
    for (const line of frontmatter[1].split('\n')) {
      const match = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
      if (!match) continue;
      metadata[match[1].toLowerCase()] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    markdown = markdown.slice(frontmatter[0].length).trim();
  }
  const heading = markdown.match(/^#\s+(.+)$/m);
  const fallbackName = path.basename(String(filename || 'Skill.md'), path.extname(String(filename || 'Skill.md')));
  const name = metadata.name || heading?.[1]?.trim() || fallbackName;
  if (!metadata.name && heading) markdown = markdown.replace(heading[0], '').trim();
  const description = metadata.description || '';
  const trigger = metadata.trigger || metadata.when || '';
  const enabled = !['false', 'no', '0', 'off'].includes(String(metadata.enabled || 'true').toLowerCase());
  return normalizeSkill({ name, description, trigger, instructions: markdown, enabled });
}

function enabledSkillsPrompt(selectedSkillIds = null) {
  const selected = Array.isArray(selectedSkillIds) ? new Set(selectedSkillIds.map(String)) : null;
  const enabled = skills.filter((skill) => skill.enabled && (!selected || selected.has(skill.id)));
  if (enabled.length === 0) return '当前没有启用的自定义 Skills。';
  return enabled.map((skill, index) => [
    `Skill ${index + 1}: ${skill.name}`,
    skill.description ? `说明：${skill.description}` : '',
    skill.trigger ? `触发条件：${skill.trigger}` : '',
    `执行指令：${skill.instructions}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function nowTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function addLog(type, title, detail = '') {
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    time: nowTime(),
    type: ['success', 'error', 'info'].includes(type) ? type : 'info',
    title: String(title || '运行事件').slice(0, 240),
    detail: String(detail || '').slice(0, 2000),
  };
  logs = [entry, ...logs].slice(0, 500);
  logWriteQueue = logWriteQueue
    .then(() => fs.appendFile(runtimeLogFile, `${JSON.stringify(entry)}\n`))
    .catch((error) => console.error(`运行日志写入失败: ${error.message}`));
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of eventClients) client.write(payload);
  return entry;
}

function publicSettings(includeSecrets = false) {
  const qqSummary = summarizeChannelRuntimes('qq', qqRuntimes);
  const feishuSummary = summarizeChannelRuntimes('feishu', feishuRuntimes);
  const wechatSummary = summarizeWechatRuntimes();
  return {
    llmProviderName: settings.llmProviderName,
    llmBaseUrl: settings.llmBaseUrl,
    llmApiKey: includeSecrets ? settings.llmApiKey : (settings.llmApiKey ? '••••••••' : ''),
    llmModel: settings.llmModel,
    systemPrompt: settings.systemPrompt || '',
    mbti: settings.mbti || 'INTJ',
    llmConfigured: Boolean(settings.llmBaseUrl && settings.llmModel),
    qqAppId: settings.qqAppId,
    qqAppSecret: includeSecrets ? settings.qqAppSecret : (settings.qqAppSecret ? '••••••••' : ''),
    qqAllowedOpenids: settings.qqAllowedOpenids,
    hasAppSecret: Boolean(settings.qqAppSecret),
    wechatConnected: wechatSummary.connected > 0,
    wechatStatus: wechatSummary.status,
    wechatConnectedCount: wechatSummary.connected,
    feishuAppId: settings.feishuAppId,
    feishuAppSecret: includeSecrets ? settings.feishuAppSecret : (settings.feishuAppSecret ? '••••••••' : ''),
    feishuDomain: settings.feishuDomain,
    feishuConnected: feishuSummary.connected > 0,
    feishuStatus: feishuSummary.status,
  };
}

function isMac() {
  return process.platform === 'darwin';
}

async function runAppleScript(lines, args = []) {
  const scriptArgs = lines.flatMap((line) => ['-e', line]);
  return execFileAsync('osascript', [...scriptArgs, ...args], { timeout: 15_000 });
}

async function getSystemStatus() {
  const qqSummary = summarizeChannelRuntimes('qq', qqRuntimes);
  const feishuSummary = summarizeChannelRuntimes('feishu', feishuRuntimes);
  const wechatSummary = summarizeWechatRuntimes();
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg()[0];
  const cores = os.cpus().length || 1;
  return {
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    cpu: Math.min(100, Math.round((load / cores) * 100)),
    memory: Math.round(((total - free) / total) * 100),
    memoryUsed: total - free,
    memoryTotal: total,
    agentVersion: '1.1.0',
    qqConnected: qqSummary.connected > 0,
    qqConnectedCount: qqSummary.connected,
    qqStatus: qqSummary.status,
    qqError: qqSummary.error,
    llmConfigured: Boolean(settings.llmBaseUrl && settings.llmModel),
    wechatConnected: wechatSummary.connected > 0,
    wechatConnectedCount: wechatSummary.connected,
    wechatStatus: wechatSummary.status,
    wechatError: wechatSummary.error,
    feishuConnected: feishuSummary.connected > 0,
    feishuConnectedCount: feishuSummary.connected,
    feishuStatus: feishuSummary.status,
    feishuError: feishuSummary.error,
  };
}

function publicNode(node) {
  const online = Date.now() - node.lastSeen < 45_000;
  return { id: node.id, name: node.name, online, lastSeen: new Date(node.lastSeen).toISOString(), status: node.status || null };
}

function authenticateNode(req, res) {
  const controlToken = String(settings.controlToken || '').trim();
  if (!controlToken) {
    res.status(503).json({ error: '主控端尚未配置 BRIGHTBOT_CONTROL_TOKEN' });
    return false;
  }
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const valid = supplied.length === controlToken.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(controlToken));
  if (!valid) {
    res.status(401).json({ error: '节点令牌无效' });
    return false;
  }
  return true;
}

function touchRemoteNode(body) {
  const id = String(body.nodeId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!id) throw new Error('缺少有效的 nodeId');
  const current = remoteNodes.get(id) || { id, jobs: [] };
  current.name = String(body.name || current.name || id).slice(0, 100);
  current.status = body.status || current.status || null;
  current.lastSeen = Date.now();
  remoteNodes.set(id, current);
  return current;
}

async function dispatchRemoteJob(nodeId, type, payload, timeout = 30_000) {
  const node = remoteNodes.get(String(nodeId));
  if (!node || Date.now() - node.lastSeen >= 45_000) throw new Error('目标节点当前离线');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remoteJobs.delete(id);
      reject(new Error('远程节点执行超时'));
    }, timeout);
    remoteJobs.set(id, { resolve, reject, timer, nodeId: node.id });
    node.jobs.push({ id, type, payload });
  });
}

async function getTargetStatus(nodeId) {
  return nodeId && nodeId !== 'local' ? dispatchRemoteJob(nodeId, 'status', {}) : getSystemStatus();
}

async function executeTargetAction(nodeId, action) {
  return nodeId && nodeId !== 'local' ? dispatchRemoteJob(nodeId, 'action', action) : executeAction(action);
}

async function executeTargetTerminal(nodeId, sessionId, command) {
  return nodeId && nodeId !== 'local'
    ? dispatchRemoteJob(nodeId, 'terminal', { sessionId, command })
    : executeTerminalCommand(sessionId, command);
}

function normalizeHotkey(value) {
  const parts = String(value).toLowerCase().split('+').map((item) => item.trim()).filter(Boolean);
  const aliases = { cmd: 'command', command: 'command', ctrl: 'control', option: 'option', alt: 'option', shift: 'shift' };
  const modifiers = parts.slice(0, -1).map((item) => aliases[item]).filter(Boolean);
  const key = parts.at(-1) || '';
  if (!/^[a-z0-9 ]$/.test(key) && !['enter', 'tab', 'escape', 'space', 'left', 'right', 'up', 'down'].includes(key)) {
    throw new Error('快捷键格式无效');
  }
  return { modifiers, key };
}

async function captureScreen() {
  const filename = `screen-${Date.now()}.png`;
  const file = path.join(screenshotDir, filename);
  if (isMac()) {
    await execFileAsync('screencapture', ['-x', file], { timeout: 15_000 });
  } else if (process.platform === 'linux') {
    await execFileAsync('gnome-screenshot', ['-f', file], { timeout: 15_000 });
  } else {
    throw new Error('当前系统需要配置截图命令');
  }
  const bytes = await fs.readFile(file);
  await fs.unlink(file).catch(() => {});
  return {
    image: `data:image/png;base64,${bytes.toString('base64')}`,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function takeScreenshot() {
  return (await captureScreen()).image;
}

async function desktopSize() {
  if (!isMac()) return null;
  const { stdout } = await runAppleScript(['tell application "Finder" to get bounds of window of desktop']);
  const values = stdout.trim().split(',').map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) throw new Error('读取桌面尺寸失败');
  return { width: values[2] - values[0], height: values[3] - values[1] };
}

async function computerInput(action) {
  if (!isMac()) throw new Error('Computer Use 当前配置为 macOS 输入驱动');
  const x = Number(action.x);
  const y = Number(action.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('缺少有效的屏幕坐标');
  const logical = await desktopSize();
  const imageWidth = Number(action.imageWidth) || logical.width;
  const imageHeight = Number(action.imageHeight) || logical.height;
  const scaledX = Math.max(0, Math.min(logical.width - 1, x * logical.width / imageWidth));
  const scaledY = Math.max(0, Math.min(logical.height - 1, y * logical.height / imageHeight));
  const args = [path.join(__dirname, 'macos-input.py'), action.type, String(scaledX), String(scaledY)];
  if (action.type === 'scroll') args.push(String(Number(action.deltaY) || -500));
  await execFileAsync('python3', args, { timeout: 15_000 });
  return { message: `已执行 ${action.type} (${Math.round(x)}, ${Math.round(y)})` };
}

function normalizeAppName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

async function scanApplications() {
  if (applicationCache.expiresAt > Date.now()) return applicationCache.names;
  const names = new Set();
  const roots = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications'];
  async function visit(directory, depth) {
    if (depth < 0) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase().endsWith('.app')) {
        names.add(entry.name.slice(0, -4));
      } else if (depth > 0) {
        await visit(path.join(directory, entry.name), depth - 1);
      }
    }
  }
  await Promise.all(roots.map((root) => visit(root, 2)));
  applicationCache = { expiresAt: Date.now() + 60_000, names: [...names].sort((a, b) => a.localeCompare(b)) };
  return applicationCache.names;
}

async function resolveApplicationName(requested) {
  const names = await scanApplications();
  const normalized = normalizeAppName(requested);
  const exact = names.find((name) => normalizeAppName(name) === normalized);
  if (exact) return exact;
  const partial = names.filter((name) => {
    const candidate = normalizeAppName(name);
    return candidate.includes(normalized) || normalized.includes(candidate);
  });
  return partial.length === 1 ? partial[0] : requested;
}

async function executeAction(action) {
  const type = action?.type;
  switch (type) {
    case 'screenshot': {
      const screen = await captureScreen();
      return { message: '已抓取当前桌面', ...screen };
    }
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
    case 'scroll':
      return computerInput(action);
    case 'open_app': {
      const requested = String(action.target || '').trim();
      if (!requested) throw new Error('缺少应用名称');
      const target = isMac() ? await resolveApplicationName(requested) : requested;
      if (isMac()) await execFileAsync('open', ['-a', target], { timeout: 15_000 });
      else await execFileAsync('xdg-open', [target], { timeout: 15_000 });
      return { message: `已启动 ${target}`, resolvedTarget: target };
    }
    case 'open_url': {
      const target = String(action.target || '').trim();
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网址需使用 HTTP 或 HTTPS');
      await execFileAsync(isMac() ? 'open' : 'xdg-open', [url.toString()], { timeout: 15_000 });
      return { message: `已打开 ${url.toString()}` };
    }
    case 'type_text': {
      const text = String(action.text || '');
      if (isMac()) {
        await runAppleScript([
          'on run argv',
          'set the clipboard to item 1 of argv',
          'tell application "System Events" to keystroke "v" using command down',
          'end run',
        ], [text]);
      } else {
        throw new Error('当前系统需要配置文本输入命令');
      }
      return { message: `已输入 ${text.length} 个字符` };
    }
    case 'hotkey': {
      const { modifiers, key } = normalizeHotkey(action.keys);
      const specialCodes = { enter: 36, tab: 48, escape: 53, space: 49, left: 123, right: 124, down: 125, up: 126 };
      const using = modifiers.length ? ` using {${modifiers.map((item) => `${item} down`).join(', ')}}` : '';
      const command = specialCodes[key] !== undefined
        ? `tell application "System Events" to key code ${specialCodes[key]}${using}`
        : `tell application "System Events" to keystroke "${key}"${using}`;
      await runAppleScript([command]);
      return { message: `已执行快捷键 ${action.keys}` };
    }
    case 'volume': {
      const value = Math.max(0, Math.min(100, Number(action.value)));
      if (isMac()) await runAppleScript([`set volume output volume ${value}`]);
      else await execFileAsync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${value}%`]);
      return { message: `音量已设为 ${value}%` };
    }
    case 'lock': {
      if (isMac()) await execFileAsync('pmset', ['displaysleepnow']);
      else await execFileAsync('loginctl', ['lock-session']);
      return { message: '锁屏指令已执行' };
    }
    case 'wait': {
      const ms = Math.max(100, Math.min(10_000, Number(action.ms) || 1000));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { message: `已等待 ${ms}ms` };
    }
    case 'shell': {
      const command = String(action.command || '').trim();
      if (!command) throw new Error('缺少终端命令');
      const { stdout, stderr } = await execAsync(command, {
        cwd: os.homedir(),
        shell: process.env.SHELL || '/bin/zsh',
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      return { message: '终端命令执行完成', output: `${stdout}${stderr}`.trim() || '(无输出)' };
    }
    default:
      throw new Error(`未知操作类型: ${type || '(空)'}`);
  }
}

function terminalPathLabel(cwd) {
  const home = os.homedir();
  if (cwd === home) return '~';
  if (cwd.startsWith(`${home}${path.sep}`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

async function executeTerminalCommand(sessionId, command) {
  const id = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'default';
  const cwd = terminalSessions.get(id)?.cwd || os.homedir();
  const marker = `__NEXUS_CWD_${crypto.randomBytes(12).toString('hex')}__`;
  const shell = process.env.SHELL || '/bin/zsh';
  const script = `${command}\nprintf '\\n${marker}%s\\n' "$PWD"`;

  return new Promise((resolve) => {
    exec(script, { cwd, shell, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout = '', stderr = '') => {
      const markerIndex = stdout.lastIndexOf(marker);
      const output = markerIndex >= 0 ? stdout.slice(0, markerIndex).replace(/\n$/, '') : stdout;
      const nextCwd = markerIndex >= 0 ? stdout.slice(markerIndex + marker.length).trim() : cwd;
      const validCwd = nextCwd && path.isAbsolute(nextCwd) ? nextCwd : cwd;
      terminalSessions.set(id, { cwd: validCwd, updatedAt: Date.now() });
      resolve({
        ok: !error,
        output: `${output}${stderr}`.trimEnd(),
        cwd: validCwd,
        cwdLabel: terminalPathLabel(validCwd),
        exitCode: error?.code ?? 0,
      });
    });
  });
}

function qqLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: (...args) => addLog('info', 'QQ Gateway 提示', args.map(String).join(' ').slice(0, 180)),
    error: (...args) => addLog('error', 'QQ Gateway 错误', args.map(String).join(' ').slice(0, 180)),
  };
}

function cleanQQContent(content) {
  return String(content || '').replace(/<@!?[^>]+>/g, '').trim();
}

function allowedQQSender(senderId, config = settings) {
  const allowed = String(config.qqAllowedOpenids || config.allowedOpenids || '').split(',').map((item) => item.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(senderId));
}

function summarizeChannelRuntimes(channel, runtimes) {
  const profiles = settings.botProfiles?.filter((profile) => profile.channel === channel && profile.config && (channel === 'qq' ? profile.config.appId && profile.config.appSecret : profile.config.appId && profile.config.appSecret)) || [];
  const states = profiles.map((profile) => runtimes.get(profile.id)?.state || { status: 'connecting', error: '' });
  return { connected: states.filter((state) => state.status === 'connected').length, status: states.find((state) => state.status === 'connected') ? 'connected' : (states[0]?.status || 'unconfigured'), error: states.find((state) => state.error)?.error || '' };
}

async function replyToQQ(bot, msg, result) {
  if (result.image && msg.replyTarget) {
    const buffer = Buffer.from(result.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await bot.sendImage(msg.replyTarget, { buffer }, { content: result.reply });
    return;
  }
  if (msg.replyTarget) {
    await bot.sendText(msg.replyTarget, result.reply);
  } else if (msg.kind === 'guild' && msg.channelId) {
    await bot.sendChannelMessage(msg.channelId, result.reply, { msgId: msg.messageId });
  } else if (msg.kind === 'dm' && msg.guildId) {
    await bot.sendDmMessage(msg.guildId, result.reply, { msgId: msg.messageId });
  }
}

async function handleQQMessage(bot, msg, profileId, config) {
  if (!allowedQQSender(msg.senderId, config)) {
    addLog('error', '已拦截未授权 QQ 用户', msg.senderId);
    return;
  }
  const raw = cleanQQContent(msg.content);
  const command = raw;
  if (!command) {
    await replyToQQ(bot, msg, { reply: '请输入指令，例如：状态、截图或打开 Safari。' });
    return;
  }
  addLog('info', '收到 QQ 官方机器人消息', `${msg.kind} · ${msg.senderId}`);
  try {
    const result = await handleAgentMessage(command, 'qq', `${profileId}:${msg.kind}:${msg.senderId}`);
    await replyToQQ(bot, msg, result);
  } catch (error) {
    addLog('error', 'QQ 指令执行失败', error.message);
    await replyToQQ(bot, msg, { reply: `执行失败：${error.message}` }).catch(() => {});
  }
}

function stopOfficialQQBot(profileId) {
  const runtime = qqRuntimes.get(profileId);
  runtime?.bot?.stop();
  if (runtime) runtime.bot = null;
}

async function startOfficialQQBot(profileId, writeLog = true) {
  const profile = settings.botProfiles.find((item) => item.id === profileId && item.channel === 'qq');
  if (!profile) return false;
  const config = profile.config || {};
  stopOfficialQQBot(profileId);
  const runtime = qqRuntimes.get(profileId) || { state: { status: 'unconfigured', error: '', connectedAt: null } };
  qqRuntimes.set(profileId, runtime);
  if (!config.appId || !config.appSecret) {
    runtime.state = { status: 'unconfigured', error: '', connectedAt: null };
    return false;
  }

  const bot = new QQBot({
    appId: String(config.appId).trim(),
    appSecret: String(config.appSecret).trim(),
    logger: qqLogger(),
    transport: 'websocket',
  });
  runtime.bot = bot;
  runtime.state = { status: 'connecting', error: '', connectedAt: null };

  bot.on('ready', () => {
    if (runtime.bot !== bot) return;
    runtime.state = { status: 'connected', error: '', connectedAt: new Date().toISOString() };
    addLog('success', 'QQ 官方机器人已连接', `AppID ${config.appId}`);
  });
  bot.on('resumed', () => {
    if (runtime.bot !== bot) return;
    runtime.state = { status: 'connected', error: '', connectedAt: new Date().toISOString() };
    addLog('success', 'QQ Gateway 已恢复连接');
  });
  bot.on('disconnected', ({ code, willReconnect }) => {
    if (runtime.bot !== bot) return;
    runtime.state = {
      status: willReconnect ? 'connecting' : 'error',
      error: `Gateway 已断开 (${code})`,
      connectedAt: null,
    };
    addLog(willReconnect ? 'info' : 'error', willReconnect ? 'QQ Gateway 正在重连' : 'QQ Gateway 已断开', String(code));
  });
  bot.on('error', (error) => {
    if (runtime.bot !== bot) return;
    runtime.state = { ...runtime.state, status: runtime.state.status === 'connected' ? 'connected' : 'error', error: error.message };
    addLog('error', 'QQ 官方机器人错误', error.message);
  });
  bot.on('message', (_ctx, msg) => handleQQMessage(bot, msg, profileId, config));

  try {
    await bot.api.getToken();
    if (writeLog) addLog('info', 'QQ 凭证验证成功', '正在连接官方 Gateway');
    bot.start().catch((error) => {
      if (runtime.bot !== bot) return;
      runtime.state = { status: 'error', error: error.message, connectedAt: null };
      addLog('error', 'QQ 官方机器人启动失败', error.message);
    });
    return true;
  } catch (error) {
    if (runtime.bot === bot) runtime.bot = null;
    bot.stop();
    runtime.state = { status: 'error', error: error.message, connectedAt: null };
    if (writeLog) addLog('error', 'QQ AppID/AppSecret 验证失败', error.message);
    return false;
  }
}

async function sendQQ({ messageType, target, message, profileId }) {
  const bot = qqRuntimes.get(profileId)?.bot;
  if (!bot) throw new Error('QQ 官方机器人尚未连接');
  const scope = messageType === 'group' ? 'group' : 'c2c';
  const data = await bot.sendText({ scope, targetId: String(target).trim() }, String(message));
  addLog('success', `QQ ${scope === 'group' ? '群' : '私聊'}消息已发送`, String(target));
  return data;
}

async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
}

function migrateBotProfiles() {
  if (!Array.isArray(settings.botProfiles)) settings.botProfiles = [];
  if (!settings.activeBotProfiles || typeof settings.activeBotProfiles !== 'object') settings.activeBotProfiles = {};
  for (const profile of settings.botProfiles) {
    if (!profile.nodeId) profile.nodeId = 'local';
    const legacyActive = settings.activeBotProfiles[profile.channel] === profile.id;
    if (legacyActive && !settings.activeBotProfiles[`local:${profile.channel}`]) settings.activeBotProfiles[`local:${profile.channel}`] = profile.id;
  }
  const legacy = [
    { channel: 'qq', name: 'QQ 官方机器人', configured: settings.qqAppId || settings.qqAppSecret, config: { appId: settings.qqAppId || '', appSecret: settings.qqAppSecret || '', allowedOpenids: settings.qqAllowedOpenids || '' } },
    { channel: 'wechat', name: '微信机器人', configured: settings.wechatToken, config: { token: settings.wechatToken || '', accountId: settings.wechatAccountId || '', baseUrl: settings.wechatBaseUrl || 'https://ilinkai.weixin.qq.com', syncBuf: settings.wechatSyncBuf || '', contextTokens: settings.wechatContextTokens || {}, processedMessageIds: settings.wechatProcessedMessageIds || [] } },
    { channel: 'feishu', name: '飞书机器人', configured: settings.feishuAppId || settings.feishuAppSecret, config: { appId: settings.feishuAppId || '', appSecret: settings.feishuAppSecret || '', domain: settings.feishuDomain || 'https://open.feishu.cn', processedMessageIds: settings.feishuProcessedMessageIds || [] } },
  ];
  for (const item of legacy) {
    if (settings.botProfiles.some((profile) => profile.channel === item.channel)) continue;
    const profile = { id: crypto.randomUUID(), nodeId: 'local', channel: item.channel, name: item.name, config: item.config, createdAt: new Date().toISOString() };
    settings.botProfiles.push(profile);
    settings.activeBotProfiles[item.channel] = profile.id;
    settings.activeBotProfiles[`local:${item.channel}`] = profile.id;
  }
}

function botActiveKey(nodeId, channel) {
  return `${nodeId || 'local'}:${channel}`;
}

function isActiveBotProfile(profile) {
  if (profile.channel === 'wechat') return Boolean(profile.config?.token);
  if (profile.channel === 'qq' || profile.channel === 'feishu') return Boolean(profile.config?.appId && profile.config?.appSecret);
  return settings.activeBotProfiles?.[botActiveKey(profile.nodeId, profile.channel)] === profile.id;
}

function publicBotProfile(profile, reveal = false) {
  const config = { ...(profile.config || {}) };
  for (const key of ['appSecret', 'token']) {
    if (!reveal && config[key]) config[key] = '••••••••';
  }
  const active = isActiveBotProfile(profile);
  return { id: profile.id, nodeId: profile.nodeId || 'local', channel: profile.channel, name: profile.name, config, active, createdAt: profile.createdAt };
}

function applyBotProfile(profile) {
  const config = profile.config || {};
  if (profile.channel === 'qq') {
    settings.qqAppId = config.appId || '';
    settings.qqAppSecret = config.appSecret || '';
    settings.qqAllowedOpenids = config.allowedOpenids || '';
  } else if (profile.channel === 'wechat') {
    settings.wechatToken = config.token || '';
    settings.wechatAccountId = config.accountId || '';
    settings.wechatBaseUrl = config.baseUrl || 'https://ilinkai.weixin.qq.com';
    settings.wechatSyncBuf = config.syncBuf || '';
    settings.wechatContextTokens = config.contextTokens || {};
    settings.wechatProcessedMessageIds = config.processedMessageIds || [];
  } else if (profile.channel === 'feishu') {
    settings.feishuAppId = config.appId || '';
    settings.feishuAppSecret = config.appSecret || '';
    settings.feishuDomain = config.domain || 'https://open.feishu.cn';
    settings.feishuProcessedMessageIds = config.processedMessageIds || [];
  }
  settings.activeBotProfiles[profile.channel] = profile.id;
  settings.activeBotProfiles[botActiveKey(profile.nodeId, profile.channel)] = profile.id;
}

function syncActiveBotProfile(channel, nodeId = 'local') {
  const activeId = settings.activeBotProfiles?.[botActiveKey(nodeId, channel)] || settings.activeBotProfiles?.[channel];
  const profile = settings.botProfiles.find((item) => item.id === activeId);
  if (!profile) return;
  if (channel === 'qq') profile.config = { appId: settings.qqAppId || '', appSecret: settings.qqAppSecret || '', allowedOpenids: settings.qqAllowedOpenids || '' };
  if (channel === 'wechat') profile.config = { token: settings.wechatToken || '', accountId: settings.wechatAccountId || '', baseUrl: settings.wechatBaseUrl || '', syncBuf: settings.wechatSyncBuf || '', contextTokens: settings.wechatContextTokens || {}, processedMessageIds: settings.wechatProcessedMessageIds || [] };
  if (channel === 'feishu') profile.config = { appId: settings.feishuAppId || '', appSecret: settings.feishuAppSecret || '', domain: settings.feishuDomain || '', processedMessageIds: settings.feishuProcessedMessageIds || [] };
}

function wechatText(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => Number(item?.type) === 1)
    .map((item) => String(item?.text_item?.text || ''))
    .join('\n')
    .trim();
}

function wechatProfile(profileId) {
  const profile = settings.botProfiles.find((item) => item.id === profileId && item.channel === 'wechat');
  if (!profile) throw new Error('微信机器人实例不存在');
  return profile;
}

function wechatRuntime(profileId) {
  if (!wechatRuntimes.has(profileId)) {
    const profile = wechatProfile(profileId);
    wechatRuntimes.set(profileId, {
      state: { status: profile.config?.token ? 'connecting' : 'unconfigured', error: '', userId: '' },
      login: null,
      abort: null,
      typingTickets: new Map(),
      processedMessageIds: new Set(Array.isArray(profile.config?.processedMessageIds) ? profile.config.processedMessageIds.map(String) : []),
    });
  }
  return wechatRuntimes.get(profileId);
}

function summarizeWechatRuntimes() {
  const profiles = settings.botProfiles?.filter((profile) => profile.channel === 'wechat' && profile.config?.token) || [];
  const states = profiles.map((profile) => wechatRuntimes.get(profile.id)?.state || { status: 'connecting', error: '' });
  const connected = states.filter((state) => state.status === 'connected').length;
  const error = states.find((state) => state.error)?.error || '';
  return { connected, status: connected ? 'connected' : (states[0]?.status || 'unconfigured'), error };
}

async function sendWechatText(profileId, userId, text) {
  const config = wechatProfile(profileId).config;
  const payload = await wechatRequest(config, 'POST', 'ilink/bot/sendmessage', {
    tokenRequired: true,
    timeout: 15_000,
    body: buildWechatText(config, userId, text),
  });
  if ((payload.ret != null && Number(payload.ret) !== 0) || (payload.errcode != null && Number(payload.errcode) !== 0)) {
    throw new Error(`微信发送被拒绝 ret=${payload.ret ?? ''} errcode=${payload.errcode ?? ''}: ${payload.errmsg || '未返回说明'}`);
  }
  addLog('info', '微信发送接口返回成功，投递待确认', JSON.stringify({
    bot: wechatProfile(profileId).name,
    ret: payload.ret ?? null,
    errcode: payload.errcode ?? null,
    messageId: payload.message_id ?? payload.msg?.message_id ?? null,
    responseFields: Object.keys(payload),
    textLength: String(text).length,
  }));
}

async function getWechatTypingTicket(profileId, userId) {
  const config = wechatProfile(profileId).config;
  const runtime = wechatRuntime(profileId);
  const contextToken = config.contextTokens?.[userId];
  if (!contextToken) return '';
  const cached = runtime.typingTickets.get(userId);
  if (cached?.expiresAt > Date.now()) return cached.ticket;
  const payload = await wechatRequest(config, 'POST', 'ilink/bot/getconfig', {
    tokenRequired: true,
    body: {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: wechatBaseInfo(),
    },
  });
  if (payload.errcode && payload.errcode !== 0) throw new Error(payload.errmsg || `获取微信输入状态失败 ${payload.errcode}`);
  const ticket = String(payload.typing_ticket || '').trim();
  if (ticket) runtime.typingTickets.set(userId, { ticket, expiresAt: Date.now() + 55_000 });
  return ticket;
}

async function setWechatTyping(profileId, userId, ticket, cancel = false) {
  if (!ticket) return;
  const payload = await wechatRequest(wechatProfile(profileId).config, 'POST', 'ilink/bot/sendtyping', {
    tokenRequired: true,
    timeout: 8_000,
    body: {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: cancel ? 2 : 1,
      base_info: wechatBaseInfo(),
    },
  });
  if (payload.errcode && payload.errcode !== 0) throw new Error(payload.errmsg || `设置微信输入状态失败 ${payload.errcode}`);
}

async function startWechatTyping(profileId, userId) {
  const ticket = await getWechatTypingTicket(profileId, userId);
  if (!ticket) return { stop: async () => {} };
  let stopped = false;
  let pending = Promise.resolve();
  const send = () => {
    if (stopped) return pending;
    pending = pending.then(() => stopped ? undefined : setWechatTyping(profileId, userId, ticket, false)).catch((error) => {
      addLog('error', '微信输入状态更新失败', error.message);
    });
    return pending;
  };
  await send();
  const timer = setInterval(send, 4500);
  const safetyTimer = setTimeout(() => stop(), 50_000);
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(safetyTimer);
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await setWechatTyping(profileId, userId, ticket, true).catch((error) => {
      addLog('error', '微信输入状态取消失败', error.message);
    });
  };
  return {
    stop,
  };
}

async function handleWechatMessage(profileId, msg) {
  const profile = wechatProfile(profileId);
  const config = profile.config;
  const runtime = wechatRuntime(profileId);
  const userId = String(msg?.from_user_id || '').trim();
  const text = wechatText(msg?.item_list);
  if (!userId || !text || userId === String(config.accountId || '')) return;
  const messageId = crypto.createHash('sha256').update(JSON.stringify(msg)).digest('hex');
  if (runtime.processedMessageIds.has(messageId)) {
    addLog('info', '忽略重复微信消息', `${userId} · ${text.slice(0, 80)}`);
    return;
  }
  runtime.processedMessageIds.add(messageId);
  config.processedMessageIds = [...runtime.processedMessageIds].slice(-300);
  if (runtime.processedMessageIds.size > 300) {
    runtime.processedMessageIds = new Set(config.processedMessageIds);
  }
  await saveSettings();
  const contextToken = String(msg?.context_token || '').trim();
  if (contextToken) {
    config.contextTokens = { ...(config.contextTokens || {}), [userId]: contextToken };
    await saveSettings();
  }
  addLog('info', '收到微信消息', `${userId} · ${text.slice(0, 80)}`);
  let typing = { stop: async () => {} };
  try {
    typing = await startWechatTyping(profileId, userId).catch((error) => {
      addLog('error', '微信输入状态启动失败', error.message);
      return { stop: async () => {} };
    });
    addLog('info', '微信状态：正在输入', userId);
    const result = await handleAgentMessage(text, 'wechat', `${profileId}:${userId}`);
    try {
      await sendWechatText(profileId, userId, result.reply);
    } finally {
      await typing.stop();
    }
  } catch (error) {
    await typing.stop();
    addLog('error', '微信指令执行失败', error.message);
    await Promise.race([
      sendWechatText(profileId, userId, `执行失败：${error.message}`).catch((sendError) => addLog('error', '微信错误提示发送失败', `${profile.name} · ${sendError.message}`)),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ]);
  }
}

async function startWechatPolling(profileId) {
  const profile = wechatProfile(profileId);
  const config = profile.config;
  const runtime = wechatRuntime(profileId);
  if (!config.token || runtime.abort) return;
  const controller = new AbortController();
  runtime.abort = controller;
  runtime.state = { status: 'connected', error: '', userId: runtime.state.userId };
  addLog('success', '微信 iLink 渠道已连接', profile.name);
  while (!controller.signal.aborted && config.token) {
    try {
      const data = await wechatRequest(config, 'POST', 'ilink/bot/getupdates', {
        tokenRequired: true,
        timeout: 40_000,
        signal: controller.signal,
        body: { base_info: wechatBaseInfo(), get_updates_buf: config.syncBuf || '' },
      });
      if (controller.signal.aborted || runtime.abort !== controller) break;
      if (data.errcode && data.errcode !== 0) throw new Error(data.errmsg || `getupdates ${data.errcode}`);
      if (data.get_updates_buf) config.syncBuf = String(data.get_updates_buf);
      for (const msg of Array.isArray(data.msgs) ? data.msgs : []) await handleWechatMessage(profileId, msg);
      if (data.get_updates_buf) await saveSettings();
    } catch (error) {
      if (controller.signal.aborted) break;
      if (/session timeout|token.*expired|unauthor/i.test(error.message)) {
        runtime.state = { ...runtime.state, status: 'expired', error: '微信登录已过期，请重新扫码' };
        profile.config = { ...profile.config, token: '', accountId: '', syncBuf: '', contextTokens: {}, processedMessageIds: [] };
        runtime.typingTickets.clear();
        runtime.processedMessageIds.clear();
        await saveSettings();
        addLog('error', `${profile.name} 登录已过期`, '请在机器人设置中重新扫码');
        break;
      }
      runtime.state = { ...runtime.state, status: 'error', error: error.message };
      addLog('error', `${profile.name} 轮询异常`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      runtime.state = { ...runtime.state, status: 'connected', error: '' };
    }
  }
  if (runtime.abort === controller) runtime.abort = null;
}

async function createWechatLogin(profileId) {
  const profile = wechatProfile(profileId);
  const runtime = wechatRuntime(profileId);
  const data = await wechatRequest(profile.config, 'GET', 'ilink/bot/get_bot_qrcode', { query: { bot_type: '3' }, timeout: 15_000 });
  if (!data.qrcode || !data.qrcode_img_content) throw new Error('微信二维码响应格式异常');
  runtime.login = { qrcode: data.qrcode, status: 'wait', image: await QRCode.toDataURL(data.qrcode_img_content, { width: 320, margin: 1 }) };
  runtime.state = { status: 'scanning', error: '', userId: '' };
  addLog('info', '微信登录二维码已生成', profile.name);
  return { status: runtime.login.status, image: runtime.login.image };
}

async function pollWechatLogin(profileId) {
  const profile = wechatProfile(profileId);
  const runtime = wechatRuntime(profileId);
  if (!runtime.login?.qrcode) return { status: runtime.state.status };
  const data = await wechatRequest(profile.config, 'GET', 'ilink/bot/get_qrcode_status', {
    query: { qrcode: runtime.login.qrcode },
    timeout: 38_000,
  });
  const status = String(data.status || 'wait');
  runtime.login.status = status;
  if (status === 'confirmed' && data.bot_token) {
    runtime.abort?.abort();
    runtime.abort = null;
    profile.config = { ...profile.config, token: String(data.bot_token), accountId: String(data.ilink_bot_id || ''), baseUrl: String(data.baseurl || profile.config.baseUrl).replace(/\/$/, ''), syncBuf: '', contextTokens: {}, processedMessageIds: [] };
    runtime.typingTickets.clear();
    runtime.processedMessageIds.clear();
    runtime.state = { status: 'connected', error: '', userId: String(data.ilink_user_id || '') };
    await saveSettings();
    runtime.login = null;
    startWechatPolling(profileId);
    return { status: 'connected' };
  }
  if (status === 'expired') runtime.state = { status: 'expired', error: '二维码已过期', userId: '' };
  return { status, image: runtime.login.image };
}

function feishuRegistrationEndpoints(domain = 'https://open.feishu.cn') {
  const normalized = String(domain || 'https://open.feishu.cn').trim().replace(/\/$/, '');
  if (normalized === 'lark' || normalized === 'https://open.larksuite.com') {
    return { openBase: 'https://open.larksuite.com', registration: 'https://accounts.larksuite.com/oauth/v1/app/registration' };
  }
  if (normalized === 'feishu' || normalized === 'https://open.feishu.cn') {
    return { openBase: 'https://open.feishu.cn', registration: 'https://accounts.feishu.cn/oauth/v1/app/registration' };
  }
  return { openBase: normalized, registration: `${normalized.replace('://open.', '://accounts.')}/oauth/v1/app/registration` };
}

function feishuRegistrationData(raw) {
  return raw?.data && typeof raw.data === 'object' ? raw.data : raw;
}

async function postFeishuRegistration(endpoint, form) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.json().catch(() => ({}));
  if (!raw || typeof raw !== 'object') throw new Error('飞书应用创建响应格式异常');
  return { status: response.status, raw };
}

function feishuProfile(profileId) {
  const profile = settings.botProfiles.find((item) => item.id === profileId && item.channel === 'feishu');
  if (!profile) throw new Error('飞书机器人实例不存在');
  return profile;
}

function feishuRuntime(profileId) {
  if (!feishuRuntimes.has(profileId)) {
    const profile = feishuProfile(profileId);
    feishuRuntimes.set(profileId, { client: null, wsClient: null, registration: null, state: { status: profile.config?.appId ? 'connecting' : 'unconfigured', error: '', connectedAt: null }, processedMessageIds: new Set(profile.config?.processedMessageIds || []) });
  }
  return feishuRuntimes.get(profileId);
}

async function createFeishuLogin(profileId, domain = 'https://open.feishu.cn') {
  const profile = feishuProfile(profileId);
  const runtime = feishuRuntime(profileId);
  const endpoints = feishuRegistrationEndpoints(domain);
  const { status, raw } = await postFeishuRegistration(endpoints.registration, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });
  const data = feishuRegistrationData(raw);
  const error = raw.error_description || data.error_description || raw.error || data.error;
  if (status >= 400 || error) throw new Error(error || '发起飞书扫码创建失败');
  const userCode = String(data.user_code || '');
  const verificationUrl = String(data.verification_uri_complete || (userCode ? `${endpoints.openBase}/page/cli?${new URLSearchParams({ user_code: userCode })}` : ''));
  if (!data.device_code || !verificationUrl) throw new Error('飞书扫码创建响应缺少必要字段');
  const expiresIn = Number(data.expires_in) || 300;
  runtime.registration = {
    deviceCode: String(data.device_code),
    domain: endpoints.openBase,
    expiresAt: Date.now() + expiresIn * 1000,
    interval: Math.max(2, Number(data.interval) || 5),
    verificationUrl,
    image: await QRCode.toDataURL(verificationUrl, { width: 320, margin: 1 }),
  };
  runtime.state = { status: 'scanning', error: '', connectedAt: null };
  addLog('info', '飞书授权二维码已生成', profile.name);
  return { status: 'pending', image: runtime.registration.image, expiresIn, interval: runtime.registration.interval };
}

async function pollLarkSecret(deviceCode) {
  const endpoints = feishuRegistrationEndpoints('lark');
  const { status, raw } = await postFeishuRegistration(endpoints.registration, { action: 'poll', device_code: deviceCode });
  if (status >= 400 || raw.error) return '';
  return String(feishuRegistrationData(raw).client_secret || '');
}

async function pollFeishuLogin(profileId) {
  const profile = feishuProfile(profileId);
  const runtime = feishuRuntime(profileId);
  if (!runtime.registration) {
    syncFeishuConnectionState(profileId);
    return { status: runtime.state.status, connected: runtime.state.status === 'connected', error: runtime.state.error };
  }
  if (Date.now() >= runtime.registration.expiresAt) {
    runtime.state = { status: 'expired', error: '二维码已过期', connectedAt: null };
    runtime.registration = null;
    return { status: 'expired' };
  }
  const endpoints = feishuRegistrationEndpoints(runtime.registration.domain);
  const { status, raw } = await postFeishuRegistration(endpoints.registration, {
    action: 'poll',
    device_code: runtime.registration.deviceCode,
  });
  const data = feishuRegistrationData(raw);
  const error = String(raw.error || data.error || '');
  if (status < 400 && !error && data.client_id) {
    const tenantBrand = String(data.user_info?.tenant_brand || data.tenant_brand || '');
    let appSecret = String(data.client_secret || '');
    if (!appSecret && tenantBrand === 'lark') appSecret = await pollLarkSecret(runtime.registration.deviceCode);
    if (!appSecret) return { status: 'error', message: '应用创建成功但未获取到凭据' };
    profile.config = { ...profile.config, appId: String(data.client_id), appSecret, domain: tenantBrand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn', processedMessageIds: [] };
    await saveSettings();
    runtime.registration = null;
    await startFeishuBot(profileId);
    return { status: runtime.state.status, connected: runtime.state.status === 'connected' };
  }
  if (error === 'authorization_pending') return { status: 'pending', image: runtime.registration.image, interval: runtime.registration.interval };
  if (error === 'slow_down') return { status: 'slow_down', image: runtime.registration.image, interval: runtime.registration.interval + 2 };
  if (error === 'access_denied') {
    runtime.state = { status: 'denied', error: '用户取消了扫码授权', connectedAt: null };
    runtime.registration = null;
    return { status: 'denied' };
  }
  if (['expired_token', 'invalid_grant'].includes(error)) {
    runtime.state = { status: 'expired', error: '二维码已过期', connectedAt: null };
    runtime.registration = null;
    return { status: 'expired' };
  }
  throw new Error(raw.error_description || data.error_description || error || '获取飞书扫码状态失败');
}

function larkDomain(config) {
  return String(config.domain || '').includes('larksuite') ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function syncFeishuConnectionState(profileId) {
  const runtime = feishuRuntime(profileId);
  if (!runtime.wsClient) return runtime.state;
  const sdkState = runtime.wsClient.getConnectionStatus?.().state;
  if (sdkState === 'connected' && runtime.state.status !== 'connected') runtime.state = { status: 'connected', error: '', connectedAt: new Date().toISOString() };
  else if (sdkState === 'reconnecting' && runtime.state.status !== 'connecting') runtime.state = { status: 'connecting', error: '', connectedAt: null };
  else if (sdkState === 'failed' && runtime.state.status !== 'error') runtime.state = { status: 'error', error: '飞书长连接建立失败', connectedAt: null };
  return runtime.state;
}

function stopFeishuBot(profileId) {
  const runtime = feishuRuntimes.get(profileId);
  const current = runtime?.wsClient;
  if (runtime) { runtime.wsClient = null; runtime.client = null; }
  current?.close({ force: true });
}

function cleanFeishuText(message) {
  let text = '';
  try { text = JSON.parse(message?.content || '{}').text || ''; } catch { text = message?.content || ''; }
  for (const mention of Array.isArray(message?.mentions) ? message.mentions : []) text = text.replaceAll(String(mention.key || ''), '');
  return String(text).trim();
}

async function sendFeishuText(profileId, chatId, text) {
  const client = feishuRuntime(profileId).client;
  if (!client) throw new Error('飞书机器人尚未连接');
  await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text) }) },
  });
}

async function handleFeishuMessage(profileId, data) {
  const profile = feishuProfile(profileId);
  const runtime = feishuRuntime(profileId);
  const message = data?.message;
  const senderId = String(data?.sender?.sender_id?.open_id || 'unknown');
  if (!message?.message_id || data?.sender?.sender_type === 'app') return;
  if (runtime.processedMessageIds.has(message.message_id)) return;
  runtime.processedMessageIds.add(message.message_id);
  profile.config.processedMessageIds = [...runtime.processedMessageIds].slice(-300);
  if (runtime.processedMessageIds.size > 300) {
    runtime.processedMessageIds = new Set(profile.config.processedMessageIds);
  }
  await saveSettings();
  const text = cleanFeishuText(message);
  if (!text) return;
  addLog('info', '收到飞书消息', `${message.chat_type} · ${senderId} · ${text.slice(0, 80)}`);
  try {
    const result = await handleAgentMessage(text, 'feishu', `${profileId}:${message.chat_id}:${senderId}`);
    await sendFeishuText(profileId, message.chat_id, result.reply);
    addLog('success', '飞书消息已回复', senderId);
  } catch (error) {
    addLog('error', '飞书指令执行失败', error.message);
    await sendFeishuText(profileId, message.chat_id, `执行失败：${error.message}`).catch(() => {});
  }
}

async function startFeishuBot(profileId) {
  const profile = feishuProfile(profileId);
  const config = profile.config || {};
  const runtime = feishuRuntime(profileId);
  stopFeishuBot(profileId);
  if (!config.appId || !config.appSecret) {
    runtime.state = { status: 'unconfigured', error: '', connectedAt: null };
    return false;
  }
  runtime.state = { status: 'connecting', error: '', connectedAt: null };
  const baseConfig = { appId: config.appId, appSecret: config.appSecret, domain: larkDomain(config) };
  const client = new Lark.Client({ ...baseConfig, appType: Lark.AppType.SelfBuild });
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.warn,
    handshakeTimeoutMs: 15_000,
    onReady: () => {
      if (runtime.wsClient !== wsClient) return;
      runtime.state = { status: 'connected', error: '', connectedAt: new Date().toISOString() };
      addLog('success', '飞书机器人已连接', profile.name);
    },
    onReconnecting: () => {
      if (runtime.wsClient !== wsClient) return;
      runtime.state = { status: 'connecting', error: '', connectedAt: null };
      addLog('info', '飞书长连接正在重连');
    },
    onReconnected: () => {
      if (runtime.wsClient !== wsClient) return;
      runtime.state = { status: 'connected', error: '', connectedAt: new Date().toISOString() };
      addLog('success', '飞书长连接已恢复');
    },
    onError: (error) => {
      if (runtime.wsClient !== wsClient) return;
      runtime.state = { status: 'error', error: error.message, connectedAt: null };
      addLog('error', '飞书机器人连接失败', error.message);
    },
  });
  runtime.client = client;
  runtime.wsClient = wsClient;
  const dispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': (data) => handleFeishuMessage(profileId, data) });
  await wsClient.start({ eventDispatcher: dispatcher });
  return true;
}

function llmEndpoint() {
  const base = String(settings.llmBaseUrl || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('请先配置模型服务地址');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

async function callLLM(messages, signal = null) {
  if (!settings.llmModel) throw new Error('请先配置模型名称');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.llmApiKey) headers.Authorization = `Bearer ${settings.llmApiKey}`;
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(60_000);
  addLog('info', '模型请求开始', settings.llmModel);
  try {
  const response = await fetch(llmEndpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.llmModel,
      messages,
      temperature: 0.1,
    }),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `模型服务请求失败 (${response.status})`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型服务返回内容为空');
  addLog('info', '模型请求完成', `${settings.llmModel} · ${Date.now() - startedAt}ms`);
  return content.trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    addLog('error', '模型请求失败', `${settings.llmModel} · ${Date.now() - startedAt}ms · ${error.message}`);
    if (timeoutSignal.aborted) throw new Error('模型服务超过 60 秒未完成响应，请稍后重试或在模型服务中切换模型。');
    throw error;
  }
}

function parseJSONResponse(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || content;
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  addLog('error', '模型操作解析失败', String(content).slice(0, 220));
  throw new Error('模型未返回可识别的操作指令');
}

function tryParseJSONResponse(content) {
  try { return parseJSONResponse(content); } catch { return null; }
}

function cleanModelText(content) {
  return String(content || '')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function normalizeAgentDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'final') return { type: 'final', message: String(value.message || value.reply || '') };
  if (value.kind === 'reply') return { type: 'final', message: String(value.reply || value.message || '') };

  let tool = value.tool || value.name || value.function?.name;
  let args = value.args ?? value.arguments ?? value.function?.arguments;
  if (value.kind === 'action' && value.action && typeof value.action === 'object') {
    tool = value.action.type;
    args = Object.fromEntries(Object.entries(value.action).filter(([key]) => key !== 'type'));
  } else if (value.type === 'action' && value.action && typeof value.action === 'object') {
    tool = value.action.type;
    args = Object.fromEntries(Object.entries(value.action).filter(([key]) => key !== 'type'));
  } else if (value.type === 'tool' && !args) {
    args = Object.fromEntries(Object.entries(value).filter(([key]) => !['type', 'tool', 'name'].includes(key)));
  }

  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (typeof tool !== 'string' || !tool.trim()) return null;
  return { type: 'tool', tool: tool.trim(), args: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
}

async function interpretWithLLM(message) {
  const content = await callLLM([
    {
      role: 'system',
      content: `你是 macOS 本机控制 Agent 的指令解析器。只输出一个 JSON 对象，不要 Markdown。\n可用格式：\n{"kind":"action","action":{"type":"status"}}\n{"kind":"action","action":{"type":"screenshot"}}\n{"kind":"action","action":{"type":"open_app","target":"应用名"}}\n{"kind":"action","action":{"type":"open_url","target":"https://..."}}\n{"kind":"action","action":{"type":"type_text","text":"内容"}}\n{"kind":"action","action":{"type":"hotkey","keys":"cmd+space"}}\n{"kind":"action","action":{"type":"volume","value":50}}\n{"kind":"action","action":{"type":"lock"}}\n{"kind":"action","action":{"type":"shell","command":"命令"}}\n如果用户只是在提问或聊天，输出 {"kind":"reply","reply":"简洁回答"}。不要杜撰缺失参数。`,
    },
    { role: 'user', content: String(message) },
  ]);
  const parsed = parseJSONResponse(content);
  if (parsed.kind === 'reply' && typeof parsed.reply === 'string') return parsed;
  const allowed = new Set(['status', 'screenshot', 'open_app', 'open_url', 'type_text', 'hotkey', 'volume', 'lock', 'shell']);
  if (parsed.kind !== 'action' || !allowed.has(parsed.action?.type)) throw new Error('模型返回了未知操作');
  return parsed;
}

function getConversation(key) {
  return conversationMemory.get(key) || [];
}

function persistConversations() {
  clearTimeout(conversationSaveTimer);
  conversationSaveTimer = setTimeout(async () => {
    const snapshot = Object.fromEntries(conversationMemory);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(conversationsFile, JSON.stringify(snapshot, null, 2));
  }, 150);
}

function rememberConversation(key, role, content) {
  const history = [...getConversation(key), { role, content: String(content).slice(0, 6000) }].slice(-20);
  conversationMemory.set(key, history);
  persistConversations();
}

function clearConversation(key) {
  conversationMemory.delete(key);
  persistConversations();
}

async function runAgentLoop(message, conversationKey, selectedSkillIds = null, signal = null, nodeId = 'local') {
  signal?.throwIfAborted();
  const applications = nodeId === 'local' ? await scanApplications() : [];
  const transcript = [
    {
      role: 'system',
      content: `你是智能电脑 Agent。当前目标系统：${nodeId === 'local' ? os.type() : (remoteNodes.get(nodeId)?.status?.platform || '远程设备，先查询状态')}。你既能正常聊天和回答问题，也能操作电脑。当前没有专用联网搜索工具；若未实际获取网页，不要宣称已经搜索或查证最新资料。\n\n如果需要调用工具，只输出：{"type":"tool","tool":"工具名","args":{}}\n如果任务结束或只是聊天咨询，可以输出 {"type":"final","message":"回复"}，也可以直接输出自然语言。一次只调用一个工具。\n\n常规工具：\nstatus {}\nscreenshot {}\nopen_app {"target":"必须优先使用下方已安装应用中的准确名称"}\nopen_url {"target":"https://..."}\ntype_text {"text":"文本"}\nhotkey {"keys":"cmd+space"}\nvolume {"value":0到100}\nlock {}\nshell {"command":"命令"}\nwait {"ms":1000}\n\nComputer Use 工具：\ncomputer_view {} 获取当前屏幕图像和像素尺寸\nclick {"x":100,"y":200}\ndouble_click {"x":100,"y":200}\nright_click {"x":100,"y":200}\nmove {"x":100,"y":200}\nscroll {"x":100,"y":200,"deltaY":-600}，负数向下、正数向上\n\n已安装应用：${applications.join('、')}\n\n需要观察界面时先 computer_view；坐标依据最新截图；工具失败后修正；不要声称未实际完成的操作。\n\n用户配置的 Prompt：\n${String(settings.systemPrompt || defaultSystemPrompt).trim()}\n\n已启用的 Skills：\n${enabledSkillsPrompt(selectedSkillIds)}\n\n当用户请求符合某个 Skill 的触发条件时，遵循该 Skill 的执行指令；不符合时不要强行使用。\n\n人格类型：${settings.mbti || 'INTJ'}。在不影响准确性和工具协议的前提下，以该 MBTI 的沟通风格回应。`,
    },
    ...getConversation(conversationKey),
    { role: 'user', content: String(message) },
  ];
  let lastResult = null;
  let lastScreen = null;
  let visualMode = false;
  let formatCorrections = 0;

  for (let step = 0; step < 10; step += 1) {
    signal?.throwIfAborted();
    const modelOutput = await callLLM(transcript, signal);
    const parsedDecision = tryParseJSONResponse(modelOutput);
    if (!parsedDecision) {
      const reply = cleanModelText(modelOutput);
      if (!reply) throw new Error('模型返回内容为空');
      rememberConversation(conversationKey, 'user', message);
      rememberConversation(conversationKey, 'assistant', reply);
      return { reply, ...(lastResult || {}) };
    }
    const decision = normalizeAgentDecision(parsedDecision);
    if (!decision) {
      if (formatCorrections < 1) {
        formatCorrections += 1;
        transcript.push({ role: 'assistant', content: modelOutput });
        transcript.push({ role: 'user', content: '上一个 JSON 不符合工具协议。请仅输出 {"type":"tool","tool":"工具名","args":{}} 或 {"type":"final","message":"回复"}，不要添加其他字段或说明。' });
        continue;
      }
      const reply = String(parsedDecision.message || parsedDecision.reply || '').trim();
      if (reply) {
        rememberConversation(conversationKey, 'user', message);
        rememberConversation(conversationKey, 'assistant', reply);
        return { reply, ...(lastResult || {}) };
      }
      throw new Error('模型连续返回了未知的操作格式');
    }
    if (decision.type === 'final') {
      const reply = String(decision.message || lastResult?.message || '任务已处理。');
      rememberConversation(conversationKey, 'user', message);
      rememberConversation(conversationKey, 'assistant', reply);
      return { reply, ...(lastResult || {}) };
    }
    const allowed = new Set(['status', 'screenshot', 'open_app', 'open_url', 'type_text', 'hotkey', 'volume', 'lock', 'shell', 'wait', 'computer_view', 'click', 'double_click', 'right_click', 'move', 'scroll']);
    if (decision.type !== 'tool' || !allowed.has(decision.tool)) {
      if (formatCorrections < 1) {
        formatCorrections += 1;
        transcript.push({ role: 'assistant', content: modelOutput });
        transcript.push({ role: 'user', content: `工具名“${decision.tool || ''}”不在可用列表中。请从 ${[...allowed].join(', ')} 中选择，并仅输出标准工具 JSON。` });
        continue;
      }
      throw new Error(`模型连续返回了未知工具：${decision.tool || '(空)'}`);
    }
    const action = {
      type: decision.tool === 'computer_view' ? 'screenshot' : decision.tool,
      ...(decision.args || {}),
      imageWidth: lastScreen?.width,
      imageHeight: lastScreen?.height,
    };
    addLog('info', `Agent 调用工具：${decision.tool}`, JSON.stringify(decision.args || {}).slice(0, 140));
    try {
      signal?.throwIfAborted();
      if (action.type === 'status') {
        const status = await getTargetStatus(nodeId);
        lastResult = { message: statusSummary(status), status };
      } else {
        lastResult = await executeTargetAction(nodeId, action);
      }
      signal?.throwIfAborted();
      if (decision.tool === 'computer_view' || action.type === 'screenshot') {
        visualMode = decision.tool === 'computer_view' || visualMode;
        lastScreen = { image: lastResult.image, width: lastResult.width, height: lastResult.height };
      } else if (visualMode && ['click', 'double_click', 'right_click', 'scroll', 'type_text', 'hotkey', 'open_app', 'open_url'].includes(action.type)) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        lastScreen = nodeId === 'local' ? await captureScreen() : await executeTargetAction(nodeId, { type: 'screenshot' });
        lastResult = { ...lastResult, ...lastScreen };
      }
      transcript.push({ role: 'assistant', content: JSON.stringify(decision) });
      const toolSummary = `工具执行成功：${JSON.stringify({ ...lastResult, image: lastResult.image ? '[SCREENSHOT_ATTACHED]' : undefined }).slice(0, 5000)}。判断目标是否完成；完成则 final，否则继续调用工具。`;
      transcript.push(lastResult.image ? {
        role: 'user',
        content: [
          { type: 'text', text: `${toolSummary}\n截图尺寸：${lastResult.width}x${lastResult.height}。` },
          { type: 'image_url', image_url: { url: lastResult.image, detail: 'high' } },
        ],
      } : { role: 'user', content: toolSummary });
      addLog('success', lastResult.message, `Agent 第 ${step + 1} 步`);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      transcript.push({ role: 'assistant', content: JSON.stringify(decision) });
      transcript.push({ role: 'user', content: `工具执行失败：${error.message}。请分析错误，修正参数或换工具重试。` });
      addLog('error', `Agent 工具失败：${decision.tool}`, error.message);
    }
  }
  const reply = lastResult?.message || '已达到本次任务的最大执行步数。';
  rememberConversation(conversationKey, 'user', message);
  rememberConversation(conversationKey, 'assistant', reply);
  return { reply, ...(lastResult || {}) };
}

function parseAgentMessage(message) {
  const text = String(message || '').trim();
  let match;
  if (/^(状态|系统状态|查看状态)$/i.test(text)) return { kind: 'action', action: { type: 'status' } };
  if (/^(截图|截屏|屏幕截图)$/i.test(text)) return { kind: 'action', action: { type: 'screenshot' } };
  if (/^(锁屏|锁定电脑)$/i.test(text)) return { kind: 'action', action: { type: 'lock' } };
  if ((match = text.match(/^(?:打开网址|访问)\s+(https?:\/\/\S+)$/i))) return { kind: 'action', action: { type: 'open_url', target: match[1] } };
  if ((match = text.match(/^(?:打开|启动)\s+(.+)$/i))) return { kind: 'action', action: { type: 'open_app', target: match[1] } };
  if ((match = text.match(/^(?:输入|键入)\s+([\s\S]+)$/i))) return { kind: 'action', action: { type: 'type_text', text: match[1] } };
  if ((match = text.match(/^(?:按下|快捷键)\s+(.+)$/i))) return { kind: 'action', action: { type: 'hotkey', keys: match[1] } };
  if ((match = text.match(/^(?:音量|设置音量)\s+(\d{1,3})%?$/i))) return { kind: 'action', action: { type: 'volume', value: Number(match[1]) } };
  if ((match = text.match(/^(?:执行命令|终端)\s+([\s\S]+)$/i))) return { kind: 'action', action: { type: 'shell', command: match[1] } };
  if ((match = text.match(/^发群消息\s+(\S+)\s+([\s\S]+)$/))) return { kind: 'qq', payload: { messageType: 'group', target: match[1], message: match[2] } };
  if ((match = text.match(/^发私聊\s+(\S+)\s+([\s\S]+)$/))) return { kind: 'qq', payload: { messageType: 'private', target: match[1], message: match[2] } };
  return { kind: 'help' };
}

function statusSummary(status) {
  const hours = Math.floor(status.uptime / 3600);
  return `${status.hostname} 正常在线，CPU ${status.cpu}%，内存 ${status.memory}%，已运行 ${hours} 小时。`;
}

async function availableControlNodes() {
  const local = await getSystemStatus();
  return [{ id: 'local', name: local.hostname, online: true }, ...[...remoteNodes.values()].map(publicNode)];
}

async function resolveConversationNode(message, conversationKey, requestedNodeId = null) {
  if (!settings.conversationNodeTargets || typeof settings.conversationNodeTargets !== 'object') settings.conversationNodeTargets = {};
  const text = String(message || '').trim();
  const nodes = await availableControlNodes();
  if (/^(查看|列出|有哪些|显示)(可用)?(服务器|设备|节点)$|^(服务器|设备|节点)列表$/i.test(text)) {
    return { reply: `可用设备：\n${nodes.map((node) => `- ${node.name}（${node.id}，${node.online ? '在线' : '离线'}）`).join('\n')}` };
  }
  if (/(?:当前|现在).*(?:连接|控制|使用).*(?:哪|什么).*(?:服务器|设备|节点)|(?:连接|控制)的是哪台/i.test(text)) {
    const currentId = requestedNodeId || settings.conversationNodeTargets[conversationKey] || 'local';
    const current = nodes.find((node) => node.id === currentId) || nodes[0];
    return { reply: `当前会话正在控制 ${current.name}（${current.id}，${current.online ? '在线' : '离线'}）。`, nodeId: current.id };
  }
  const switchMatch = text.match(/(?:^|请|你|帮我|麻烦)(?:现在|立即)?\s*(?:切换到|选择|使用|控制)\s*[“"']?(.+?)[”"']?[。！!？?]?$/i);
  if (switchMatch) {
    const requestedName = switchMatch[1].trim().replace(/(?:这台)?(?:服务器|设备|节点)$/i, '').trim();
    const target = requestedName.toLowerCase();
    const matches = nodes.filter((node) => node.id.toLowerCase() === target || node.name.toLowerCase() === target || node.name.toLowerCase().includes(target));
    if (matches.length !== 1) {
      return { reply: matches.length > 1 ? '匹配到多个设备，请发送完整设备名称。' : `没有找到“${requestedName}”。\n${nodes.map((node) => `- ${node.name}（${node.online ? '在线' : '离线'}）`).join('\n')}` };
    }
    if (!matches[0].online) return { reply: `设备“${matches[0].name}”当前离线。` };
    settings.conversationNodeTargets[conversationKey] = matches[0].id;
    await saveSettings();
    return { reply: `已切换到 ${matches[0].name}，后续指令将在该设备执行。`, nodeId: matches[0].id };
  }
  const nodeId = requestedNodeId || settings.conversationNodeTargets[conversationKey] || 'local';
  const node = nodes.find((item) => item.id === nodeId);
  return { nodeId: node?.online ? nodeId : 'local' };
}

async function handleAgentMessage(message, source = 'web', conversationId = source, selectedSkillIds = null, signal = null, nodeId = null) {
  addLog('info', `收到${source === 'qq' ? ' QQ' : ''}指令`, String(message).slice(0, 120));
  const conversationKey = `${source}:${conversationId}`;
  if (/^(清空上下文|清除上下文|开始新对话|新对话)$/i.test(String(message).trim())) {
    clearConversation(conversationKey);
    return { reply: '上下文已清空，我们开始一段新对话。' };
  }
  const target = await resolveConversationNode(message, conversationKey, nodeId);
  if (target.reply) return target;
  nodeId = target.nodeId;
  if (settings.llmBaseUrl && settings.llmModel) {
    return runAgentLoop(message, conversationKey, selectedSkillIds, signal, nodeId);
  }
  let parsed = parseAgentMessage(message);
  if (parsed.kind === 'help') {
    if (settings.llmBaseUrl && settings.llmModel) {
      parsed = await interpretWithLLM(message);
    } else {
      return {
        reply: '可执行：状态、截图、打开 Safari、打开网址 https://example.com、输入 文本、快捷键 cmd+space、音量 50、锁屏、终端 pwd。配置模型服务后也支持自然语言指令。',
      };
    }
  }
  if (parsed.kind === 'reply') {
    return { reply: parsed.reply };
  }
  if (parsed.kind === 'qq') {
    await sendQQ(parsed.payload);
    return { reply: 'QQ 消息发送完成。' };
  }
  if (parsed.action.type === 'status') {
    const status = await getTargetStatus(nodeId);
    return { reply: statusSummary(status), status };
  }
  const result = await executeTargetAction(nodeId, parsed.action);
  addLog('success', result.message, source === 'qq' ? '来自 QQ' : '来自网页');
  return { reply: result.message, ...result };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/vnc/status', async (req, res, next) => {
  try {
    const nodeId = String(req.query.nodeId || 'local');
    const status = nodeId === 'local'
      ? await bundledVncStatus({ host: vncHost, port: vncPort })
      : await dispatchRemoteJob(nodeId, 'vnc-status', {}, 10_000);
    res.json({ ...status, host: vncHost, port: vncPort, nodeId });
  }
  catch (error) { next(error); }
});
app.post('/api/vnc/ticket', (req, res) => {
  if (!currentAuthSession(req)) return res.status(401).json({ error: '请先登录', authenticationRequired: true });
  const nodeId = String(req.body.nodeId || 'local');
  if (nodeId !== 'local') {
    const node = remoteNodes.get(nodeId);
    if (!node || Date.now() - node.lastSeen >= 45_000) return res.status(409).json({ error: '目标节点当前离线' });
  }
  const ticket = crypto.randomBytes(24).toString('base64url');
  vncTickets.set(ticket, { expiresAt: Date.now() + 30_000, nodeId });
  return res.json({ ticket });
});
app.post('/api/vnc/start', async (req, res, next) => {
  try {
    if (!currentAuthSession(req)) return res.status(401).json({ error: '请先登录', authenticationRequired: true });
    const nodeId = String(req.body.nodeId || 'local');
    const status = nodeId === 'local'
      ? (await startBundledVnc({ host: vncHost, port: vncPort }), await bundledVncStatus({ host: vncHost, port: vncPort }))
      : await dispatchRemoteJob(nodeId, 'vnc-start', {}, 15_000);
    return res.json({ ...status, host: vncHost, port: vncPort, nodeId });
  } catch (error) { return next(error); }
});
app.post('/api/vnc/stop', async (req, res, next) => {
  try {
    if (!currentAuthSession(req)) return res.status(401).json({ error: '请先登录', authenticationRequired: true });
    stopBundledVnc();
    return res.json({ ...(await bundledVncStatus({ host: vncHost, port: vncPort })), host: vncHost, port: vncPort });
  } catch (error) { return next(error); }
});
app.post('/api/node/poll', (req, res, next) => {
  try {
    if (!authenticateNode(req, res)) return;
    const node = touchRemoteNode(req.body || {});
    const jobs = node.jobs.splice(0, 5);
    res.json({ jobs, pollAfterMs: jobs.length ? 100 : 1500 });
  } catch (error) { next(error); }
});
app.post('/api/node/result', (req, res, next) => {
  try {
    if (!authenticateNode(req, res)) return;
    const node = touchRemoteNode(req.body || {});
    const pending = remoteJobs.get(String(req.body.jobId || ''));
    if (pending && pending.nodeId === node.id) {
      clearTimeout(pending.timer);
      remoteJobs.delete(req.body.jobId);
      if (req.body.ok === false) pending.reject(new Error(String(req.body.error || '远程执行失败')));
      else pending.resolve(req.body.result);
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/setup/status', (req, res) => {
  res.json({
    initialized: settings.authInitialized === true,
    brightwebConfigured: Boolean(settings.brightwebClientId),
    callbackUrl: brightwebRedirectUri(req),
  });
});
app.post('/api/setup/initialize', async (req, res, next) => {
  try {
    if (settings.authInitialized) return res.status(409).json({ error: '系统已经完成初始化' });
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const clientId = String(req.body.brightwebClientId || '').trim();
    if (username.length < 3) throw new Error('管理员账号至少需要 3 个字符');
    if (password.length < 8) throw new Error('管理员密码至少需要 8 个字符');
    settings.authUsername = username;
    settings.authPasswordHash = await scryptPassword(password);
    settings.authInitialized = true;
    settings.brightwebIssuer = 'https://auth.brightweb.top/oidc';
    settings.brightwebClientId = clientId;
    settings.brightwebClientSecret = String(req.body.brightwebClientSecret || '').trim();
    settings.brightwebRedirectUri = String(req.body.brightwebRedirectUri || '').trim();
    settings.brightwebAllowedUsers = String(req.body.brightwebAllowedUsers || '').trim();
    await saveSettings();
    createAuthSession(req, res, { username, provider: 'local' });
    addLog('success', 'BrightBot 初始化完成', username);
    return res.status(201).json({ authenticated: true, initialized: true, username });
  } catch (error) { return next(error); }
});
app.get('/api/auth/session', (req, res) => {
  const session = currentAuthSession(req);
  res.json({
    initialized: settings.authInitialized === true,
    authenticated: Boolean(session),
    username: session?.username || '',
    provider: session?.provider || '',
    brightwebConfigured: Boolean(settings.brightwebClientId),
  });
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!settings.authInitialized) return res.status(428).json({ error: '请先完成系统初始化' });
    const username = String(req.body.username || '').trim();
    const valid = username === settings.authUsername && await verifyPassword(req.body.password, settings.authPasswordHash);
    if (!valid) return res.status(401).json({ error: '账号或密码错误' });
    createAuthSession(req, res, { username, provider: 'local' });
    addLog('success', '控制台账号已登录', username);
    return res.json({ authenticated: true, username, provider: 'local' });
  } catch (error) { return next(error); }
});
app.get('/api/auth/brightweb/start', (req, res) => {
  if (!settings.authInitialized) return res.redirect('/?auth_error=setup_required');
  if (!settings.brightwebClientId) return res.redirect('/?auth_error=brightweb_not_configured');
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  oidcAttempts.set(state, { verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
  const authorize = new URL('https://auth.brightweb.top/oidc/auth');
  authorize.search = new URLSearchParams({
    client_id: settings.brightwebClientId,
    redirect_uri: brightwebRedirectUri(req),
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    max_age: '0',
  }).toString();
  return res.redirect(authorize.toString());
});
app.get('/api/auth/brightweb/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const attempt = oidcAttempts.get(state);
  oidcAttempts.delete(state);
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    if (!attempt || attempt.expiresAt <= Date.now()) throw new Error('OIDC 登录状态已过期');
    const code = String(req.query.code || '');
    if (!code) throw new Error('OIDC 回调缺少授权码');
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: brightwebRedirectUri(req),
      client_id: settings.brightwebClientId,
      code_verifier: attempt.verifier,
    });
    if (settings.brightwebClientSecret) tokenBody.set('client_secret', settings.brightwebClientSecret);
    const tokenResponse = await fetch('https://auth.brightweb.top/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.id_token) throw new Error(tokens.error_description || tokens.error || 'BrightWeb Token 交换失败');
    const verified = await jwtVerify(tokens.id_token, brightwebJwks, {
      issuer: 'https://auth.brightweb.top/oidc',
      audience: settings.brightwebClientId,
    });
    const profile = verified.payload;
    if (!brightwebUserAllowed(profile)) throw new Error('该 BrightWeb 账号未加入 BrightBot 登录白名单');
    const username = String(profile.preferred_username || profile.username || profile.email || profile.name || profile.sub);
    createAuthSession(req, res, { username, provider: 'brightweb', sub: String(profile.sub), email: String(profile.email || '') });
    addLog('success', 'BrightWeb 统一认证登录成功', username);
    return res.redirect('/?auth=success');
  } catch (error) {
    addLog('error', 'BrightWeb 统一认证登录失败', error.message);
    return res.redirect(`/?auth_error=${encodeURIComponent(error.message)}`);
  }
});
app.post('/api/auth/logout', (req, res) => {
  const session = currentAuthSession(req);
  if (session) authSessions.delete(session.token);
  setAuthCookie(req, res, '', 0);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (currentAuthSession(req)) return next();
  return res.status(401).json({ error: '请先登录', authenticationRequired: true });
});
app.get('/api/auth/brightweb/config', (req, res) => {
  res.json({
    issuer: settings.brightwebIssuer,
    clientId: settings.brightwebClientId,
    clientSecret: settings.brightwebClientSecret ? '••••••••' : '',
    hasClientSecret: Boolean(settings.brightwebClientSecret),
    redirectUri: brightwebRedirectUri(req),
    allowedUsers: settings.brightwebAllowedUsers || '',
  });
});
app.put('/api/auth/brightweb/config', async (req, res, next) => {
  try {
    settings.brightwebIssuer = 'https://auth.brightweb.top/oidc';
    settings.brightwebClientId = String(req.body.clientId || '').trim();
    if (req.body.clientSecret && req.body.clientSecret !== '••••••••') settings.brightwebClientSecret = String(req.body.clientSecret).trim();
    if (req.body.clientSecret === '') settings.brightwebClientSecret = '';
    settings.brightwebRedirectUri = String(req.body.redirectUri || '').trim();
    settings.brightwebAllowedUsers = String(req.body.allowedUsers || '').trim();
    await saveSettings();
    for (const [token, session] of authSessions) {
      if (session.provider === 'brightweb') authSessions.delete(token);
    }
    addLog('success', 'BrightWeb 统一认证配置已保存', settings.brightwebClientId || '已停用');
    res.json({
      issuer: settings.brightwebIssuer,
      clientId: settings.brightwebClientId,
      clientSecret: settings.brightwebClientSecret ? '••••••••' : '',
      hasClientSecret: Boolean(settings.brightwebClientSecret),
      redirectUri: brightwebRedirectUri(req),
      allowedUsers: settings.brightwebAllowedUsers || '',
    });
  } catch (error) { next(error); }
});
app.get('/api/nodes', async (_req, res, next) => {
  try {
    const local = await getSystemStatus();
    res.json([{ id: 'local', name: local.hostname, online: true, lastSeen: new Date().toISOString(), status: local }, ...[...remoteNodes.values()].map(publicNode)]);
  } catch (error) { next(error); }
});
app.get('/api/cluster/config', (req, res) => {
  res.json({
    masterUrl: settings.masterPublicUrl || requestOrigin(req),
    token: settings.controlToken || '',
    configured: Boolean(settings.controlToken),
  });
});
app.put('/api/cluster/config', async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const masterUrl = String(req.body.masterUrl || '').trim().replace(/\/$/, '');
    if (token && token.length < 24) throw new Error('共享令牌至少需要 24 个字符');
    if (masterUrl && !/^https?:\/\//i.test(masterUrl)) throw new Error('主控地址需要以 http:// 或 https:// 开头');
    settings.controlToken = token;
    settings.masterPublicUrl = masterUrl;
    await saveSettings();
    for (const pending of remoteJobs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('主控令牌已更新'));
    }
    remoteJobs.clear();
    addLog('success', '设备节点配置已保存', token ? '远程节点接入已启用' : '远程节点接入已停用');
    res.json({ masterUrl: settings.masterPublicUrl || requestOrigin(req), token, configured: Boolean(token) });
  } catch (error) { next(error); }
});
app.delete('/api/nodes/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'local') return res.status(400).json({ error: '主控本机节点不可移除' });
  remoteNodes.delete(id);
  res.json({ ok: true });
});
app.get('/api/status', async (req, res, next) => {
  try { res.json(await getTargetStatus(String(req.query.nodeId || 'local'))); } catch (error) { next(error); }
});
app.get('/api/logs', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const type = String(req.query.type || 'all');
  const query = String(req.query.q || '').trim().toLowerCase();
  const filtered = logs.filter((entry) => {
    if (type !== 'all' && entry.type !== type) return false;
    return !query || `${entry.title} ${entry.detail}`.toLowerCase().includes(query);
  });
  res.json(filtered.slice(0, limit));
});
app.delete('/api/logs', async (_req, res, next) => {
  try {
    logs = [];
    logWriteQueue = logWriteQueue.then(() => fs.writeFile(runtimeLogFile, ''));
    await logWriteQueue;
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
});
app.get('/api/settings', (req, res) => {
  const includeSecrets = req.query.reveal === '1';
  res.json(publicSettings(includeSecrets));
});
app.get('/api/skills', (_req, res) => res.json(skills));
app.get('/api/scheduled-tasks', (_req, res) => {
  res.json([...scheduledTasks].sort((a, b) => {
    if (!a.nextRunAt) return 1;
    if (!b.nextRunAt) return -1;
    return new Date(a.nextRunAt) - new Date(b.nextRunAt);
  }));
});
app.post('/api/scheduled-tasks', async (req, res, next) => {
  try {
    const task = normalizeScheduledTask(req.body);
    scheduledTasks.push(task);
    await saveScheduledTasks();
    addLog('success', '后台定时任务已创建', task.name);
    res.status(201).json(task);
  } catch (error) { next(error); }
});
app.put('/api/scheduled-tasks/:id', async (req, res, next) => {
  try {
    const index = scheduledTasks.findIndex((task) => task.id === req.params.id);
    if (index < 0) throw new Error('定时任务不存在');
    const task = normalizeScheduledTask(req.body, scheduledTasks[index]);
    scheduledTasks[index] = task;
    await saveScheduledTasks();
    addLog('success', task.enabled ? '后台定时任务已更新' : '后台定时任务已暂停', task.name);
    res.json(task);
  } catch (error) { next(error); }
});
app.post('/api/scheduled-tasks/:id/run', async (req, res, next) => {
  try {
    const task = scheduledTasks.find((item) => item.id === req.params.id);
    if (!task) throw new Error('定时任务不存在');
    res.json(await executeScheduledTask(task, true));
  } catch (error) { next(error); }
});
app.delete('/api/scheduled-tasks/:id', async (req, res, next) => {
  try {
    const task = scheduledTasks.find((item) => item.id === req.params.id);
    if (!task) throw new Error('定时任务不存在');
    if (runningScheduledTasks.has(task.id)) throw new Error('任务正在执行中');
    scheduledTasks = scheduledTasks.filter((item) => item.id !== task.id);
    await saveScheduledTasks();
    addLog('success', '后台定时任务已删除', task.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/bots', (req, res) => {
  const reveal = req.query.reveal === '1';
  const nodeId = String(req.query.nodeId || 'local');
  res.json(settings.botProfiles.filter((profile) => (profile.nodeId || 'local') === nodeId).map((profile) => {
    const result = publicBotProfile(profile, reveal);
    const runtime = profile.channel === 'wechat' ? wechatRuntimes.get(profile.id) : profile.channel === 'qq' ? qqRuntimes.get(profile.id) : feishuRuntimes.get(profile.id);
    return { ...result, status: runtime?.state.status || (result.active ? 'connecting' : 'unconfigured') };
  }));
});
app.post('/api/bots', async (req, res, next) => {
  try {
    const channel = String(req.body.channel || '');
    if (!['qq', 'wechat', 'feishu'].includes(channel)) throw new Error('机器人渠道无效');
    const profile = {
      id: crypto.randomUUID(),
      nodeId: String(req.body.nodeId || 'local').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'local',
      channel,
      name: String(req.body.name || `${channel === 'qq' ? 'QQ' : channel === 'wechat' ? '微信' : '飞书'}机器人`).trim().slice(0, 60),
      config: channel === 'qq' ? { appId: '', appSecret: '', allowedOpenids: '' } : channel === 'wechat' ? { token: '', accountId: '', baseUrl: 'https://ilinkai.weixin.qq.com', syncBuf: '', contextTokens: {}, processedMessageIds: [] } : { appId: '', appSecret: '', domain: 'https://open.feishu.cn', processedMessageIds: [] },
      createdAt: new Date().toISOString(),
    };
    settings.botProfiles.push(profile);
    await saveSettings();
    addLog('success', '机器人实例已创建', profile.name);
    res.status(201).json(publicBotProfile(profile, true));
  } catch (error) { next(error); }
});
app.put('/api/bots/:id', async (req, res, next) => {
  try {
    const profile = settings.botProfiles.find((item) => item.id === req.params.id);
    if (!profile) throw new Error('机器人实例不存在');
    profile.name = String(req.body.name ?? profile.name).trim().slice(0, 60) || profile.name;
    const incoming = req.body.config && typeof req.body.config === 'object' ? req.body.config : {};
    const nextConfig = { ...profile.config, ...incoming };
    for (const key of ['appSecret', 'token']) if (!incoming[key] || incoming[key] === '••••••••') nextConfig[key] = profile.config?.[key] || '';
    profile.config = nextConfig;
    if (isActiveBotProfile(profile)) applyBotProfile(profile);
    await saveSettings();
    res.json(publicBotProfile(profile, true));
  } catch (error) { next(error); }
});
app.post('/api/bots/:id/activate', async (req, res, next) => {
  try {
    const profile = settings.botProfiles.find((item) => item.id === req.params.id);
    if (!profile) throw new Error('机器人实例不存在');
    if (profile.channel === 'wechat' && profile.config?.token) startWechatPolling(profile.id);
    if (profile.channel === 'qq') await startOfficialQQBot(profile.id, false);
    if (profile.channel === 'feishu') await startFeishuBot(profile.id);
    await saveSettings();
    addLog('success', '机器人实例已启动', profile.name);
    res.json(publicBotProfile(profile, true));
  } catch (error) { next(error); }
});
app.delete('/api/bots/:id', async (req, res, next) => {
  try {
    const profile = settings.botProfiles.find((item) => item.id === req.params.id);
    if (!profile) throw new Error('机器人实例不存在');
    if (profile.channel === 'wechat') {
      const runtime = wechatRuntimes.get(profile.id);
      runtime?.abort?.abort();
      wechatRuntimes.delete(profile.id);
    } else {
      if (profile.channel === 'qq') { stopOfficialQQBot(profile.id); qqRuntimes.delete(profile.id); }
      if (profile.channel === 'feishu') { stopFeishuBot(profile.id); feishuRuntimes.delete(profile.id); }
    }
    settings.botProfiles = settings.botProfiles.filter((item) => item.id !== profile.id);
    await saveSettings();
    addLog('success', '机器人实例已删除', profile.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post('/api/skills', async (req, res, next) => {
  try {
    const skill = normalizeSkill(req.body);
    skills = [skill, ...skills];
    await saveSkills();
    addLog('success', 'Skill 已创建', skill.name);
    res.status(201).json(skill);
  } catch (error) { next(error); }
});
app.post('/api/skills/import', async (req, res, next) => {
  try {
    const skill = parseSkillMarkdown(req.body.content, req.body.filename);
    skills = [skill, ...skills];
    await saveSkills();
    addLog('success', 'Markdown Skill 已导入', `${skill.name} · ${req.body.filename || 'Skill.md'}`);
    res.status(201).json(skill);
  } catch (error) { next(error); }
});
app.put('/api/skills/:id', async (req, res, next) => {
  try {
    const index = skills.findIndex((skill) => skill.id === req.params.id);
    if (index < 0) throw new Error('Skill 不存在');
    const skill = normalizeSkill(req.body, skills[index]);
    skills[index] = skill;
    await saveSkills();
    addLog('success', skill.enabled ? 'Skill 已更新' : 'Skill 已停用', skill.name);
    res.json(skill);
  } catch (error) { next(error); }
});
app.delete('/api/skills/:id', async (req, res, next) => {
  try {
    const skill = skills.find((item) => item.id === req.params.id);
    if (!skill) throw new Error('Skill 不存在');
    skills = skills.filter((item) => item.id !== req.params.id);
    await saveSkills();
    addLog('success', 'Skill 已删除', skill.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/settings/secrets', (req, res) => {
  const host = String(req.hostname || '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    return res.status(403).json({ error: '密钥仅允许从本机控制台读取' });
  }
  return res.json({
    llmApiKey: settings.llmApiKey || '',
    qqAppSecret: settings.qqAppSecret || '',
    feishuAppSecret: settings.feishuAppSecret || '',
  });
});
app.put('/api/settings', async (req, res, next) => {
  try {
    const nextSettings = { ...settings, ...req.body };
    if (!req.body.llmApiKey || req.body.llmApiKey === '••••••••') nextSettings.llmApiKey = settings.llmApiKey;
    if (!req.body.qqAppSecret || req.body.qqAppSecret === '••••••••') nextSettings.qqAppSecret = settings.qqAppSecret;
    if (!req.body.feishuAppSecret || req.body.feishuAppSecret === '••••••••') nextSettings.feishuAppSecret = settings.feishuAppSecret;
    if (typeof nextSettings.systemPrompt !== 'string') throw new Error('Prompt 必须是文本');
    nextSettings.systemPrompt = nextSettings.systemPrompt.trim().slice(0, 20_000) || defaultSystemPrompt;
    const mbtiTypes = new Set(['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP', 'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP']);
    nextSettings.mbti = String(nextSettings.mbti || 'INTJ').toUpperCase();
    if (!mbtiTypes.has(nextSettings.mbti)) throw new Error('MBTI 类型无效');
    settings = nextSettings;
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
    addLog('success', 'Agent 配置已保存');
    // Robot profiles manage their own connections.
    res.json(publicSettings());
  } catch (error) { next(error); }
});
app.post('/api/action', async (req, res, next) => {
  try {
    const result = await executeTargetAction(req.body.nodeId || 'local', req.body);
    addLog('success', result.message, req.body.type);
    res.json(result);
  } catch (error) { next(error); }
});
app.post('/api/terminal/execute', async (req, res, next) => {
  try {
    const command = String(req.body.command || '').trim();
    if (!command) throw new Error('缺少终端命令');
    const result = await executeTargetTerminal(req.body.nodeId || 'local', req.body.sessionId, command);
    addLog(result.ok ? 'success' : 'error', '网页终端执行命令', command);
    res.json(result);
  } catch (error) { next(error); }
});
app.get('/api/agent/context', (req, res) => {
  const conversationId = String(req.query.conversationId || 'web').slice(0, 100);
  res.json({ messages: getConversation(`web:${conversationId}`) });
});
app.post('/api/agent/message', async (req, res, next) => {
  const requestId = String(req.body.requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const controller = new AbortController();
  agentRuns.get(requestId)?.abort();
  agentRuns.set(requestId, controller);
  try {
    const conversationId = String(req.body.conversationId || 'web').slice(0, 100);
    const selectedSkillIds = Array.isArray(req.body.skillIds) ? req.body.skillIds.slice(0, 50) : null;
    res.json(await handleAgentMessage(req.body.message, 'web', conversationId, selectedSkillIds, controller.signal, req.body.nodeId || 'local'));
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      addLog('info', '网页对话已停止生成', requestId);
      return res.status(499).json({ error: '回答已停止', canceled: true });
    }
    return next(error);
  } finally {
    if (agentRuns.get(requestId) === controller) agentRuns.delete(requestId);
  }
});
app.post('/api/agent/cancel', (req, res) => {
  const requestId = String(req.body.requestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const controller = agentRuns.get(requestId);
  if (controller) controller.abort();
  res.json({ ok: true, canceled: Boolean(controller) });
});
app.delete('/api/agent/context', async (req, res) => {
  clearConversation(`web:${String(req.query.conversationId || 'web')}`);
  res.json({ ok: true });
});
app.post('/api/llm/test', async (_req, res, next) => {
  try {
    const reply = await callLLM([
      { role: 'system', content: '只回复 OK' },
      { role: 'user', content: '测试连接' },
    ]);
    addLog('success', '模型服务连接成功', settings.llmModel);
    res.json({ connected: true, reply });
  } catch (error) { next(error); }
});
app.post('/api/qq/test', async (req, res) => {
  const profileId = String(req.body?.profileId || '');
  const credentialsValid = await startOfficialQQBot(profileId, true);
  const state = qqRuntimes.get(profileId)?.state || { status: 'unconfigured', error: '' };
  res.json({ connected: credentialsValid, status: state.status, error: state.error });
});
app.post('/api/qq/send', async (req, res, next) => {
  try { res.json({ ok: true, data: await sendQQ(req.body) }); } catch (error) { next(error); }
});
app.post('/api/wechat/login', async (req, res, next) => {
  try { res.json(await createWechatLogin(String(req.body?.profileId || ''))); } catch (error) { next(error); }
});
app.get('/api/wechat/login/status', async (req, res, next) => {
  try { res.json(await pollWechatLogin(String(req.query.profileId || ''))); } catch (error) { next(error); }
});
app.post('/api/wechat/logout', async (req, res, next) => {
  try {
    const profile = wechatProfile(String(req.body?.profileId || ''));
    const runtime = wechatRuntime(profile.id);
    runtime.abort?.abort();
    runtime.abort = null;
    runtime.login = null;
    runtime.typingTickets.clear();
    runtime.processedMessageIds.clear();
    runtime.state = { status: 'unconfigured', error: '', userId: '' };
    profile.config = { ...profile.config, token: '', accountId: '', syncBuf: '', contextTokens: {}, processedMessageIds: [] };
    await saveSettings();
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post('/api/feishu/login', async (req, res, next) => {
  try { res.json(await createFeishuLogin(String(req.body?.profileId || ''), req.body?.domain)); } catch (error) { next(error); }
});
app.get('/api/feishu/login/status', async (req, res, next) => {
  try { res.json(await pollFeishuLogin(String(req.query.profileId || ''))); } catch (error) { next(error); }
});
app.post('/api/feishu/logout', async (req, res, next) => {
  try {
    const profile = feishuProfile(String(req.body?.profileId || ''));
    const runtime = feishuRuntime(profile.id);
    stopFeishuBot(profile.id);
    runtime.registration = null;
    runtime.processedMessageIds.clear();
    runtime.state = { status: 'unconfigured', error: '', connectedAt: null };
    profile.config = { ...profile.config, appId: '', appSecret: '', processedMessageIds: [] };
    await saveSettings();
    addLog('info', '飞书机器人已退出');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  addLog('error', '操作执行失败', error.message);
  res.status(400).json({ error: error.message || '请求失败' });
});

const distDir = path.join(rootDir, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

await bootstrap();
const server = app.listen(port, listenHost, async () => {
  addLog('success', 'Agent 服务已启动', `http://${listenHost}:${port}`);
  console.log(`Agent API listening on http://${listenHost}:${port}`);
  for (const profile of settings.botProfiles.filter((item) => item.channel === 'qq' && item.config?.appId && item.config?.appSecret)) await startOfficialQQBot(profile.id, false);
  for (const profile of settings.botProfiles.filter((item) => item.channel === 'feishu' && item.config?.appId && item.config?.appSecret)) await startFeishuBot(profile.id);
  for (const profile of settings.botProfiles.filter((item) => item.channel === 'wechat' && item.config?.token)) startWechatPolling(profile.id);
  startScheduler();
  const vncStart = await startBundledVnc({ host: vncHost, port: vncPort });
  if (vncStart.started) addLog('success', '内置 VNC 服务已启动', `${vncHost}:${vncPort}`);
  else if (process.platform === 'linux' && vncStart.error) addLog('error', '内置 VNC 服务启动失败', vncStart.error);
});

const vncWebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const nodeVncWebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  if (pathname === '/api/node/vnc') {
    const suppliedToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const nodeId = String(requestUrl.searchParams.get('nodeId') || '');
    const sessionId = String(requestUrl.searchParams.get('sessionId') || '');
    const session = remoteVncSessions.get(sessionId);
    if (!settings.controlToken || suppliedToken !== settings.controlToken || !session || session.nodeId !== nodeId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    nodeVncWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      webSocket.vncSessionId = sessionId;
      nodeVncWebSocketServer.emit('connection', webSocket);
    });
    return;
  }
  if (pathname !== '/api/vnc') return;
  const ticket = requestUrl.searchParams.get('ticket') || '';
  const ticketInfo = vncTickets.get(ticket);
  vncTickets.delete(ticket);
  if (!ticketInfo || ticketInfo.expiresAt <= Date.now()) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  vncWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
    webSocket.vncNodeId = ticketInfo.nodeId;
    vncWebSocketServer.emit('connection', webSocket);
  });
});

vncWebSocketServer.on('connection', (webSocket) => {
  const nodeId = webSocket.vncNodeId || 'local';
  webSocket.binaryType = 'arraybuffer';
  webSocket._socket?.setNoDelay(true);
  if (nodeId === 'local') {
    const target = net.createConnection({ host: vncHost, port: vncPort });
    target.setNoDelay(true);
    target.on('data', (chunk) => {
      if (webSocket.readyState !== 1) return;
      if (webSocket.bufferedAmount > 1024 * 1024) target.pause();
      webSocket.send(chunk, { binary: true, compress: false }, () => target.resume());
    });
    webSocket.on('message', (data) => target.writable && target.write(Buffer.from(data)));
    target.on('error', () => webSocket.close(1011, 'VNC service unavailable'));
    target.on('close', () => webSocket.close());
    webSocket.on('close', () => target.destroy());
    webSocket.on('error', () => target.destroy());
    return;
  }

  const sessionId = crypto.randomUUID();
  const session = { nodeId, browser: webSocket, node: null, pending: [], timer: null };
  session.timer = setTimeout(() => {
    remoteVncSessions.delete(sessionId);
    if (webSocket.readyState === 1) webSocket.close(1011, 'Remote VNC tunnel timeout');
  }, 15_000);
  remoteVncSessions.set(sessionId, session);
  webSocket.on('message', (data) => {
    const chunk = Buffer.from(data);
    if (session.node?.readyState === 1) session.node.send(chunk, { binary: true });
    else if (session.pending.length < 64) session.pending.push(chunk);
  });
  webSocket.on('close', () => {
    clearTimeout(session.timer);
    remoteVncSessions.delete(sessionId);
    session.node?.close();
  });
  webSocket.on('error', () => session.node?.close());
  dispatchRemoteJob(nodeId, 'vnc-tunnel', { sessionId }, 20_000).catch((error) => {
    clearTimeout(session.timer);
    remoteVncSessions.delete(sessionId);
    if (webSocket.readyState === 1) webSocket.close(1011, error.message.slice(0, 120));
  });
});

nodeVncWebSocketServer.on('connection', (webSocket) => {
  const sessionId = webSocket.vncSessionId;
  const session = remoteVncSessions.get(sessionId);
  if (!session || session.node) return webSocket.close(1008, 'Invalid VNC session');
  clearTimeout(session.timer);
  session.node = webSocket;
  webSocket.binaryType = 'arraybuffer';
  webSocket._socket?.setNoDelay(true);
  for (const chunk of session.pending.splice(0)) webSocket.send(chunk, { binary: true, compress: false });
  webSocket.on('message', (data) => {
    if (session.browser.readyState !== 1) return;
    if (session.browser.bufferedAmount > 1024 * 1024) webSocket._socket?.pause();
    session.browser.send(Buffer.from(data), { binary: true, compress: false }, () => webSocket._socket?.resume());
  });
  webSocket.on('close', () => {
    remoteVncSessions.delete(sessionId);
    if (session.browser.readyState === 1) session.browser.close();
  });
  webSocket.on('error', () => session.browser.close(1011, 'Remote VNC tunnel error'));
});

server.on('error', (error) => {
  console.error(`Agent API 启动失败: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const profileId of qqRuntimes.keys()) stopOfficialQQBot(profileId);
    for (const profileId of feishuRuntimes.keys()) stopFeishuBot(profileId);
    clearInterval(schedulerTimer);
    for (const runtime of wechatRuntimes.values()) runtime.abort?.abort();
    for (const session of remoteVncSessions.values()) {
      clearTimeout(session.timer);
      session.browser?.close();
      session.node?.close();
    }
    remoteVncSessions.clear();
    stopBundledVnc();
    process.exit(0);
  });
}
