import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import RFB from '@novnc/novnc';
import { Activity, AppWindow, Bell, Bot, CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, Command, Computer, Copy, Cpu, Database, Eye, EyeOff, FileCog, FileUp, Gauge, Keyboard, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Maximize2, MemoryStick, Menu, MessageCircle, MonitorUp, MousePointer2, Network, Pause, Pencil, Play, Plus, Puzzle, RefreshCw, Save, ScreenShare, Send, ShieldCheck, Sparkles, Square, Terminal, Trash2, UserRound, Volume2, X } from 'lucide-react';

const shortcuts = [
  { icon: ScreenShare, label: '截取屏幕', description: '查看当前桌面', type: 'screenshot', tone: 'blue' },
  { icon: AppWindow, label: '打开应用', description: '启动本机应用', type: 'open_app', tone: 'violet' },
  { icon: Keyboard, label: '输入文字', description: '写入焦点位置', type: 'type_text', tone: 'green' },
  { icon: Command, label: '执行快捷键', description: '触发组合按键', type: 'hotkey', tone: 'amber' },
  { icon: Volume2, label: '调节音量', description: '设置系统音量', type: 'volume', tone: 'cyan' },
  { icon: Terminal, label: '终端命令', description: '运行本机命令', type: 'shell', tone: 'red' },
];

const actionForms = {
  open_app: { title: '打开应用', label: '应用名称', field: 'target', placeholder: '例如 Safari、访达、微信' },
  type_text: { title: '输入文字', label: '输入内容', field: 'text', placeholder: '文字将粘贴到当前焦点位置', multiline: true },
  hotkey: { title: '执行快捷键', label: '组合键', field: 'keys', placeholder: '例如 cmd+space、cmd+c' },
  volume: { title: '调节音量', label: '音量值', field: 'value', placeholder: '0 - 100', inputType: 'number' },
  shell: { title: '终端命令', label: '命令', field: 'command', placeholder: '例如 pwd 或 ls -la', mono: true },
};

async function api(url, options) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`接口返回格式异常 (${response.status})，请重启 Agent 服务`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

const formatBytes = (bytes = 0) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

function App() {
  const [auth, setAuth] = useState({ loading: true, initialized: true, authenticated: false, username: '', brightwebConfigured: false });
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [actionModal, setActionModal] = useState(null);
  const [screenshot, setScreenshot] = useState('');
  const [toast, setToast] = useState(null);
  const [running, setRunning] = useState('');
  const [page, setPage] = useState('welcome');
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('local');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const dashboardAreaRef = useRef(null);

  useEffect(() => {
    api('/api/auth/session').then((session) => setAuth({ loading: false, ...session })).catch(() => setAuth({ loading: false, initialized: true, authenticated: false, username: '', brightwebConfigured: false }));
  }, []);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api(`/api/status?nodeId=${encodeURIComponent(selectedNodeId)}`)); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
  }, [selectedNodeId]);

  useEffect(() => {
    if (!auth.authenticated) return undefined;
    Promise.all([refreshStatus(), api('/api/logs').then(setLogs), api('/api/nodes').then(setNodes)]).catch(() => {});
    const timer = setInterval(refreshStatus, 15000);
    const events = new EventSource('/api/events');
    events.onmessage = (event) => setLogs((current) => [JSON.parse(event.data), ...current].slice(0, 500));
    return () => { clearInterval(timer); events.close(); };
  }, [auth.authenticated, refreshStatus]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    dashboardAreaRef.current?.scrollTo({ top: 0 });
    setMobileNavOpen(false);
  }, [page]);

  const runAction = async (payload) => {
    setActionModal(null);
    setRunning(payload.type);
    try {
      const result = await api('/api/action', { method: 'POST', body: JSON.stringify({ ...payload, nodeId: selectedNodeId }) });
      if (result.image) setScreenshot(result.image);
      setToast({ type: 'success', text: result.message });
      refreshStatus();
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setRunning(''); }
  };

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuth((current) => ({ ...current, loading: false, authenticated: false, username: '', provider: '' }));
    setStatus(null);
    setLogs([]);
    setPage('welcome');
  };

  if (auth.loading) return <div className="auth-loading"><LoaderCircle className="spin" size={24} />正在验证登录状态</div>;
  if (!auth.initialized) return <SetupPage onComplete={(session) => setAuth({ loading: false, brightwebConfigured: Boolean(session.brightwebConfigured), ...session })} />;
  if (!auth.authenticated) return <LoginPage brightwebConfigured={auth.brightwebConfigured} onLogin={(session) => setAuth((current) => ({ ...current, loading: false, ...session }))} />;

  if (page === 'chat') {
    return <><ChatWorkspace status={status} nodes={nodes} nodeId={selectedNodeId} setNodeId={setSelectedNodeId} setToast={setToast} onBack={() => setPage('welcome')} onLogout={logout} />{toast && <div className={`toast ${toast.type}`}>{toast.type === 'success' ? <Check size={17} /> : <CircleAlert size={17} />}{toast.text}</div>}</>;
  }

  const connectedChannels = [status?.qqConnected, status?.wechatConnected, status?.feishuConnected].filter(Boolean).length;
  const connectionLabel = connectedChannels > 0 ? `${connectedChannels} 个在线` : '待配置';

  return (
    <div className="dashboard-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand"><div className="brand-mark"><img src="/brightbot-star.jpg" alt="" /></div><strong>BrightBot</strong><button className="mobile-menu-button" onClick={() => setMobileNavOpen((value) => !value)} aria-label={mobileNavOpen ? '关闭导航' : '打开导航'}>{mobileNavOpen ? <X size={20} /> : <Menu size={20} />}</button></div>
        <div className="nav-label">系统</div>
        <nav className="nav-list">
          <button className={`nav-item ${page === 'welcome' ? 'active' : ''}`} onClick={() => setPage('welcome')}><LayoutDashboard size={18} /><span>欢迎</span></button>
          <button className={`nav-item ${page === 'agent' ? 'active' : ''}`} onClick={() => setPage('agent')}><Bot size={18} /><span>机器人</span></button>
          <button className={`nav-item ${page === 'model' ? 'active' : ''}`} onClick={() => setPage('model')}><Sparkles size={18} /><span>模型服务</span></button>
          <button className={`nav-item ${page === 'profile' ? 'active' : ''}`} onClick={() => setPage('profile')}><FileCog size={18} /><span>配置文件</span></button>
          <button className={`nav-item ${page === 'skills' ? 'active' : ''}`} onClick={() => setPage('skills')}><Puzzle size={18} /><span>Skills</span></button>
          <button className={`nav-item ${page === 'tasks' ? 'active' : ''}`} onClick={() => setPage('tasks')}><CalendarClock size={18} /><span>定时任务</span></button>
          <button className={`nav-item ${page === 'logs' ? 'active' : ''}`} onClick={() => setPage('logs')}><Activity size={18} /><span>数据与日志</span></button>
        </nav>
        <div className="nav-label secondary-label">设备</div>
        <nav className="nav-list">
          <button className={`nav-item ${page === 'control' ? 'active' : ''}`} onClick={() => setPage('control')}><Computer size={18} /><span>电脑控制</span></button>
          <button className={`nav-item ${page === 'desktop' ? 'active' : ''}`} onClick={() => setPage('desktop')}><ScreenShare size={18} /><span>远程桌面</span></button>
          <button className={`nav-item ${page === 'commands' ? 'active' : ''}`} onClick={() => setPage('commands')}><Terminal size={18} /><span>命令工具</span></button>
          <button className={`nav-item ${page === 'nodes' ? 'active' : ''}`} onClick={() => setPage('nodes')}><Network size={18} /><span>设备节点</span></button>
        </nav>
        <div className="sidebar-bottom">
          <span>Agent v{status?.agentVersion || '1.0.0'}</span>
        </div>
      </aside>
      {mobileNavOpen && <button className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航" />}

      <div className="dashboard-area" ref={dashboardAreaRef}>
        <header className="dashboard-topbar">
          <div><span className="topbar-path">控制中心</span><ChevronRight size={14} /><strong>{page === 'welcome' ? '概览' : page === 'agent' ? '机器人设置' : page === 'model' ? '模型服务' : page === 'profile' ? '配置文件' : page === 'skills' ? 'Skills' : page === 'tasks' ? '定时任务' : page === 'logs' ? '数据与日志' : page === 'control' ? '电脑控制' : page === 'desktop' ? '远程桌面' : page === 'nodes' ? '设备节点' : '命令工具'}</strong></div>
          <div className="topbar-actions"><label className="node-picker"><MonitorUp size={15} /><select value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id} disabled={!node.online}>{node.name}{node.online ? '' : '（离线）'}</option>)}</select></label><ViewSwitcher active="control" onControl={() => setPage('welcome')} onChat={() => setPage('chat')} /><button className="icon-button" onClick={() => { refreshStatus(); api('/api/nodes').then(setNodes).catch(() => {}); }} title="刷新状态"><RefreshCw size={17} /></button><button className="icon-button" onClick={logout} title="退出登录"><LogOut size={17} /></button></div>
        </header>

        {page === 'welcome' && <main className="dashboard-content">
          <section className="welcome-block">
            <div><span className="eyebrow">BRIGHTBOT CONTROL CENTER</span><h1>下午好，欢迎使用 BrightBot</h1><p>管理本机设备、模型服务和消息通道，所有服务状态一目了然。</p></div>
            <div className="welcome-device"><MonitorUp size={25} /><div><strong>{status?.hostname || '正在连接设备'}</strong><span>{status?.platform || '本机 Agent'}</span></div><i /></div>
          </section>

          <section className="stats-grid">
            <StatCard icon={Cpu} label="CPU 使用率" value={`${status?.cpu || 0}%`} progress={status?.cpu || 0} tone="blue" />
            <StatCard icon={MemoryStick} label="内存使用率" value={`${status?.memory || 0}%`} detail={status ? `${formatBytes(status.memoryUsed)} / ${formatBytes(status.memoryTotal)}` : '读取中'} progress={status?.memory || 0} tone="violet" />
            <StatCard icon={MessageCircle} label="机器人通道" value={connectionLabel} detail="管理 QQ、微信与飞书机器人" tone="green" />
            <StatCard icon={Gauge} label="持续运行" value={formatUptime(status?.uptime)} detail={`架构 ${status?.arch || '—'}`} tone="amber" />
          </section>

          <section className="dashboard-card quick-card">
            <div className="card-heading"><div><h2>快捷控制</h2><p>选择一个操作立即控制当前电脑</p></div><button className="text-button" onClick={() => runAction({ type: 'lock' })}><LockKeyhole size={15} />锁定屏幕</button></div>
            <div className="action-grid">{shortcuts.map((item) => { const Icon = item.icon; return <button key={item.type} className={`action-tile ${item.tone}`} onClick={() => item.type === 'screenshot' ? runAction({ type: 'screenshot' }) : setActionModal(item.type)}><span className="action-icon">{running === item.type ? <LoaderCircle className="spin" size={20} /> : <Icon size={20} />}</span><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={16} /></button>; })}</div>
          </section>

          <div className="dashboard-lower">
            <section className="dashboard-card service-card"><div className="card-heading"><div><h2>服务状态</h2><p>关键连接与运行环境</p></div></div><ServiceRow icon={Computer} name="本机控制服务" detail="仅监听 127.0.0.1" status="运行中" healthy /><ServiceRow icon={Sparkles} name="模型服务" detail={status?.llmConfigured ? 'API 已完成配置' : '等待配置 API'} status={status?.llmConfigured ? '可用' : '待配置'} healthy={status?.llmConfigured} /><ServiceRow icon={MessageCircle} name="消息机器人" detail="QQ · 微信 · 飞书" status={connectionLabel} healthy={connectedChannels > 0} /></section>
            <section className="dashboard-card activity-card"><div className="card-heading"><div><h2>最近活动</h2><p>Agent 实时运行记录</p></div><Activity size={17} /></div><div className="activity-list">{logs.length === 0 && <div className="empty-activity"><Database size={21} />暂无运行记录</div>}{logs.slice(0, 5).map((log) => <div className="activity-row" key={log.id}><i className={log.type} /><div><strong>{log.title}</strong><span>{log.detail || '操作已完成'}</span></div><time>{log.time}</time></div>)}</div></section>
          </div>
        </main>}
        {page === 'agent' && <AgentWorkspace status={status} nodeId={selectedNodeId} refreshStatus={refreshStatus} setToast={setToast} />}
        {page === 'model' && <ModelWorkspace setToast={setToast} />}
        {page === 'profile' && <ProfileWorkspace setToast={setToast} />}
        {page === 'skills' && <SkillsWorkspace setToast={setToast} />}
        {page === 'tasks' && <ScheduledTasksWorkspace setToast={setToast} />}
        {page === 'logs' && <LogsWorkspace logs={logs} setLogs={setLogs} setToast={setToast} />}
        {page === 'control' && <ComputerControl running={running} runAction={runAction} setActionModal={setActionModal} />}
        {page === 'desktop' && <RemoteDesktop nodeId={selectedNodeId} status={status} setToast={setToast} />}
        {page === 'commands' && <CommandWorkspace status={status} nodeId={selectedNodeId} setToast={setToast} />}
        {page === 'nodes' && <NodesWorkspace setToast={setToast} onNodesChange={setNodes} />}
      </div>

      {actionModal && <ActionModal type={actionModal} onClose={() => setActionModal(null)} onRun={runAction} />}
      {screenshot && <ScreenshotModal src={screenshot} onClose={() => setScreenshot('')} />}
      {toast && <div className={`toast ${toast.type}`}>{toast.type === 'success' ? <Check size={17} /> : <CircleAlert size={17} />}{toast.text}</div>}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, detail, progress, tone }) { return <article className={`stat-card ${tone}`}><div className="stat-top"><span className="stat-icon"><Icon size={19} /></span><span className="stat-label">{label}</span></div><strong className="stat-value">{value}</strong>{detail && <small>{detail}</small>}{progress !== undefined && <div className="stat-track"><i style={{ width: `${progress}%` }} /></div>}</article>; }
function ServiceRow({ icon: Icon, name, detail, status, healthy }) { return <div className="service-row"><span className="service-icon"><Icon size={18} /></span><div><strong>{name}</strong><small>{detail}</small></div><span className={`service-status ${healthy ? 'healthy' : ''}`}><i />{status}</span></div>; }
function ViewSwitcher({ active, onControl, onChat }) { return <div className="view-switcher" aria-label="页面切换"><button className={active === 'control' ? 'active' : ''} onClick={onControl}><LayoutDashboard size={14} />控制中心</button><button className={active === 'chat' ? 'active' : ''} onClick={onChat}><MessageCircle size={14} />对话</button></div>; }

function NodesWorkspace({ setToast, onNodesChange }) {
  const [config, setConfig] = useState({ masterUrl: '', token: '' });
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextNodes] = await Promise.all([api('/api/cluster/config'), api('/api/nodes')]);
      setConfig({ masterUrl: nextConfig.masterUrl || '', token: nextConfig.token || '' });
      setNodes(nextNodes);
      onNodesChange(nextNodes);
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  }, [onNodesChange, setToast]);
  useEffect(() => { refresh(); }, [refresh]);
  const generateToken = () => {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    setConfig((current) => ({ ...current, token: [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('') }));
    setShowToken(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      const result = await api('/api/cluster/config', { method: 'PUT', body: JSON.stringify(config) });
      setConfig({ masterUrl: result.masterUrl, token: result.token });
      setToast({ type: 'success', text: '设备节点配置已保存' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };
  const copy = async (text, message) => {
    await navigator.clipboard.writeText(text);
    setToast({ type: 'success', text: message });
  };
  const remove = async (node) => {
    if (!window.confirm(`移除节点记录“${node.name}”？`)) return;
    try {
      await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const clientConfig = `BRIGHTBOT_MODE=node\nBRIGHTBOT_MASTER_URL=${config.masterUrl || 'https://主控域名'}\nBRIGHTBOT_CONTROL_TOKEN=${config.token || '共享令牌'}\nBRIGHTBOT_NODE_ID=server-2\nBRIGHTBOT_NODE_NAME=业务服务器-2`;
  const onlineCount = nodes.filter((node) => node.online).length;
  return <main className="nodes-page"><section className="nodes-heading"><div><span className="eyebrow">DISTRIBUTED AGENT</span><h1>设备节点</h1><p>配置主控接入信息并管理由当前 AI 控制的服务器。</p></div><button className="secondary-button" onClick={refresh}><RefreshCw size={15} />刷新节点</button></section>{loading ? <div className="nodes-loading"><LoaderCircle className="spin" />读取设备配置…</div> : <><section className="nodes-summary"><div><Network size={20} /><span><strong>{nodes.length}</strong><small>全部设备</small></span></div><div><CircleCheck size={20} /><span><strong>{onlineCount}</strong><small>当前在线</small></span></div><p>客户端每隔约 1.5 秒主动连接主控，无需开放客户端入站端口。</p></section><section className="nodes-layout"><div className="node-config-panel"><div className="nodes-section-title"><div><h2>主控配置</h2><p>保存后新令牌立即生效，现有客户端需要同步更新。</p></div><button className="primary-button" onClick={save} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? '保存中' : '保存配置'}</button></div><label><span>主控访问地址</span><input value={config.masterUrl} onChange={(event) => setConfig((current) => ({ ...current, masterUrl: event.target.value }))} placeholder="https://控制台域名" /></label><label><span>共享令牌</span><div className="node-token-input"><input type={showToken ? 'text' : 'password'} value={config.token} onChange={(event) => setConfig((current) => ({ ...current, token: event.target.value }))} placeholder="至少 24 个字符" /><button onClick={() => setShowToken((value) => !value)} title={showToken ? '隐藏令牌' : '显示令牌'}>{showToken ? <EyeOff size={17} /> : <Eye size={17} />}</button><button onClick={generateToken} title="生成随机令牌"><RefreshCw size={17} /></button></div></label><div className="client-config"><header><div><strong>客户端配置</strong><span>修改节点 ID 和名称后部署到其他服务器</span></div><button onClick={() => copy(clientConfig, '客户端配置已复制')} title="复制客户端配置"><Copy size={16} /></button></header><pre>{clientConfig}</pre></div></div><div className="node-list-panel"><div className="nodes-section-title"><div><h2>已连接设备</h2><p>主控本机与远程客户端的实时状态。</p></div></div><div className="node-list">{nodes.map((node) => <article className="node-row" key={node.id}><span className={`node-status-dot ${node.online ? 'online' : ''}`} /><div><strong>{node.name}</strong><small>{node.id === 'local' ? '主控本机' : node.id} · {node.status?.platform || '等待状态上报'}</small><span>{node.online ? `CPU ${node.status?.cpu || 0}% · 内存 ${node.status?.memory || 0}%` : `最后在线 ${new Date(node.lastSeen).toLocaleString('zh-CN')}`}</span></div><em className={node.online ? 'online' : ''}>{node.online ? '在线' : '离线'}</em>{node.id !== 'local' && !node.online && <button className="icon-button danger" onClick={() => remove(node)} title="移除节点记录"><Trash2 size={15} /></button>}</article>)}</div></div></section></>}</main>;
}

function SetupPage({ onComplete }) {
  const [form, setForm] = useState({ username: '', password: '', confirmPassword: '', brightwebClientId: '', brightwebClientSecret: '', brightwebRedirectUri: '', brightwebAllowedUsers: '' });
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/setup/status').then((result) => { setCallbackUrl(result.callbackUrl); setForm((current) => ({ ...current, brightwebRedirectUri: result.callbackUrl })); }).catch(() => {}); }, []);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (form.password !== form.confirmPassword) return setError('两次输入的密码不一致');
    setLoading(true);
    setError('');
    try {
      const result = await api('/api/setup/initialize', { method: 'POST', body: JSON.stringify(form) });
      onComplete({ ...result, brightwebConfigured: Boolean(form.brightwebClientId.trim()) });
    } catch (submitError) { setError(submitError.message); }
    finally { setLoading(false); }
  };
  return <main className="setup-page"><section className="setup-shell"><header><div className="login-brand"><span><img src="/brightbot-star.jpg" alt="" /></span><strong>BrightBot</strong></div><span>INITIAL SETUP</span><h1>初始化控制中心</h1><p>创建本机管理员，并配置 BrightWeb 统一认证。</p></header><form className="setup-form" onSubmit={submit}><div className="setup-section"><div><strong>管理员账号</strong><small>用于统一认证不可用时的本机登录。</small></div><div className="setup-fields"><label><span>管理员账号</span><input autoFocus value={form.username} onChange={update('username')} placeholder="至少 3 个字符" /></label><label><span>管理员密码</span><input type="password" value={form.password} onChange={update('password')} placeholder="至少 8 个字符" /></label><label><span>确认密码</span><input type="password" value={form.confirmPassword} onChange={update('confirmPassword')} placeholder="再次输入管理员密码" /></label></div></div><div className="setup-section"><div><strong>BrightWeb OIDC</strong><small>客户端 ID 必填后启用统一认证，客户端密钥可按应用类型留空。</small></div><div className="setup-fields"><label><span>Client ID</span><input value={form.brightwebClientId} onChange={update('brightwebClientId')} placeholder="BrightWeb 应用 Client ID" /></label><label><span>Client Secret</span><input type="password" value={form.brightwebClientSecret} onChange={update('brightwebClientSecret')} placeholder="公共客户端可留空" /></label><label className="full"><span>回调地址</span><input value={form.brightwebRedirectUri} onChange={update('brightwebRedirectUri')} placeholder={callbackUrl} /></label><label className="full"><span>允许登录的用户</span><textarea rows={4} value={form.brightwebAllowedUsers} onChange={update('brightwebAllowedUsers')} placeholder="填写邮箱、用户名或用户 ID，每行一个" /></label></div></div>{error && <div className="login-error"><CircleAlert size={15} />{error}</div>}<footer><small>认证端点：https://auth.brightweb.top/oidc</small><button className="login-submit" disabled={loading || !form.username.trim() || form.password.length < 8}>{loading ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{loading ? '正在初始化' : '完成初始化'}</button></footer></form></section></main>;
}

function LoginPage({ onLogin, brightwebConfigured }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) setError(authError === 'brightweb_not_configured' ? 'BrightWeb 统一认证尚未配置' : authError);
    if (authError || params.get('auth')) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  const submit = async (event) => {
    event.preventDefault();
    if (!form.username.trim() || !form.password) return;
    setLoading(true);
    setError('');
    try { onLogin(await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) })); }
    catch (submitError) { setError(submitError.message); }
    finally { setLoading(false); }
  };
  return <main className="login-page"><section className="login-visual"><img src="/brightbot-favicon.jpg" alt="" /><div><span>BRIGHTBOT CONSOLE</span><h1>连接你的智能工作空间</h1><p>统一管理模型、机器人、Skills 与本机控制能力。</p></div></section><section className="login-panel"><form className="login-form" onSubmit={submit}><div className="login-brand"><span><img src="/brightbot-star.jpg" alt="" /></span><strong>BrightBot</strong></div><div className="login-heading"><span><ShieldCheck size={17} />安全访问</span><h2>登录控制中心</h2><p>使用 BrightWeb 统一认证或本机管理员账号。</p></div>{brightwebConfigured && <><a className="brightweb-login" href="/api/auth/brightweb/start"><ShieldCheck size={17} />使用 BrightWeb 登录</a><div className="login-divider"><span>或使用本机管理员</span></div></>}<label><span>账号</span><input autoFocus={!brightwebConfigured} autoComplete="username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} placeholder="请输入账号" /></label><label><span>密码</span><div className="login-secret"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="请输入密码" /><button type="button" onClick={() => setShowPassword((value) => !value)} title={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>{error && <div className="login-error"><CircleAlert size={15} />{error}</div>}<button className="login-submit" disabled={loading || !form.username.trim() || !form.password}>{loading ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}{loading ? '正在登录' : '本机账号登录'}</button><small>本机管理员凭据仅保存在当前 BrightBot 服务中。</small></form></section></main>;
}

function ChatWorkspace({ status, nodes, nodeId, setNodeId, setToast, onBack, onLogout }) {
  const [messages, setMessages] = useState([]);
  const [skills, setSkills] = useState([]);
  const [skillMode, setSkillMode] = useState('auto');
  const [selectedSkillIds, setSelectedSkillIds] = useState([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const requestIdRef = useRef('');

  useEffect(() => {
    Promise.all([api(`/api/agent/context?conversationId=${encodeURIComponent(`web:${nodeId}`)}`), api('/api/skills')])
      .then(([context, skillList]) => {
        setMessages(Array.isArray(context.messages) ? context.messages : []);
        setSkills(Array.isArray(skillList) ? skillList.filter((skill) => skill.enabled) : []);
      })
      .catch((error) => setToast({ type: 'error', text: error.message }))
      .finally(() => setLoading(false));
  }, [nodeId, setToast, status?.platform]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, sending]);

  const send = async (event, preset) => {
    event?.preventDefault();
    const text = String(preset ?? input).trim();
    if (!text || sending) return;
    const userMessage = { role: 'user', content: text, localId: `user-${Date.now()}` };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setSending(true);
    const requestId = globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}`;
    requestIdRef.current = requestId;
    try {
      const result = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ message: text, conversationId: `web:${nodeId}`, nodeId, requestId, skillIds: skillMode === 'manual' ? selectedSkillIds : undefined }) });
      setMessages((current) => [...current, { role: 'assistant', content: result.reply || result.message || '任务已处理。', image: result.image || '', localId: `assistant-${Date.now()}` }]);
    } catch (error) {
      if (error.message !== '回答已停止') {
        setMessages((current) => [...current, { role: 'error', content: error.message, localId: `error-${Date.now()}` }]);
        setToast({ type: 'error', text: error.message });
      }
    } finally {
      if (requestIdRef.current === requestId) requestIdRef.current = '';
      setSending(false);
      setStopping(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };
  const stopGenerating = async () => {
    const requestId = requestIdRef.current;
    if (!requestId || stopping) return;
    setStopping(true);
    try { await api('/api/agent/cancel', { method: 'POST', body: JSON.stringify({ requestId }) }); }
    catch (error) { setToast({ type: 'error', text: error.message }); setStopping(false); }
  };
  const clear = async () => {
    if (messages.length > 0 && !window.confirm('清空网页对话和 Agent 上下文？')) return;
    try {
      await api(`/api/agent/context?conversationId=${encodeURIComponent(`web:${nodeId}`)}`, { method: 'DELETE' });
      setMessages([]);
      setToast({ type: 'success', text: '网页对话已清空' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(event);
    }
  };
  const suggestions = ['查看当前电脑状态', '截取当前屏幕', '打开 Safari', '帮我总结最近的对话'];
  const toggleSelectedSkill = (id) => setSelectedSkillIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const skillLabel = skillMode === 'auto' ? 'Skills 自动' : selectedSkillIds.length > 0 ? `Skills ${selectedSkillIds.length}` : '不使用 Skills';

  return <main className="standalone-chat"><aside className="chat-sidebar"><div className="chat-sidebar-brand"><span><img src="/brightbot-star.jpg" alt="" /></span><strong>BrightBot <em>ChatUI</em></strong></div><button className="chat-new" onClick={clear}><Plus size={16} />新建对话</button><div className="chat-sidebar-label">对话</div><button className="chat-thread active"><MessageCircle size={16} /><span><strong>当前对话</strong><small>{messages.length} 条消息</small></span></button><footer><i />Agent 在线</footer></aside><section className="chat-page"><section className="chat-shell"><header className="chat-header"><div className="chat-agent"><span><Bot size={20} /></span><div><strong>BrightBot</strong><small><i />{status?.llmConfigured ? '模型与 Skills 已就绪' : '基础控制模式'}</small></div></div><div className="chat-header-actions"><label className="node-picker chat-node-picker"><MonitorUp size={15} /><select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id} disabled={!node.online}>{node.name}{node.online ? '' : '（离线）'}</option>)}</select></label><ViewSwitcher active="chat" onControl={onBack} onChat={() => {}} /><button className="icon-button" onClick={clear} title="清空对话" disabled={messages.length === 0}><Trash2 size={17} /></button><button className="icon-button" onClick={onLogout} title="退出登录"><LogOut size={17} /></button></div></header><div className="chat-messages" ref={scrollRef}>{loading ? <div className="chat-loading"><LoaderCircle className="spin" />加载对话…</div> : messages.length === 0 ? <div className="chat-empty"><span><Sparkles size={27} /></span><h1>今天需要处理什么？</h1><p>可以直接聊天，也可以让 Agent 操作当前电脑。</p><div className="chat-suggestions">{suggestions.map((item) => <button key={item} onClick={(event) => send(event, item)}>{item}<ChevronRight size={14} /></button>)}</div></div> : messages.map((message, index) => <div className={`chat-message ${message.role}`} key={message.localId || `${message.role}-${index}`}><span className="chat-avatar">{message.role === 'user' ? <UserRound size={16} /> : message.role === 'error' ? <CircleAlert size={16} /> : <Bot size={16} />}</span><div className="chat-bubble"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{message.content}</ReactMarkdown>{message.image && <button className="chat-image" onClick={() => window.open(message.image, '_blank')}><img src={message.image} alt="Agent 截图结果" /></button>}</div></div>)}{sending && <div className="chat-message assistant"><span className="chat-avatar"><Bot size={16} /></span><div className="chat-bubble chat-thinking"><i /><i /><i /></div></div>}</div><form className="chat-composer" onSubmit={send}><div><textarea ref={inputRef} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} placeholder="发送消息或电脑操作指令" disabled={sending} />{sending ? <button type="button" className="stop-generation" onClick={stopGenerating} disabled={stopping} title="停止生成">{stopping ? <LoaderCircle className="spin" size={17} /> : <Square size={15} fill="currentColor" />}</button> : <button type="submit" disabled={!input.trim()} title="发送消息"><Send size={18} /></button>}</div><footer><div className="chat-skill-picker"><button type="button" className={skillMode === 'manual' ? 'manual' : ''} onClick={() => setSkillMenuOpen((value) => !value)}><Puzzle size={14} />{skillLabel}<ChevronDown size={13} /></button>{skillMenuOpen && <div className="chat-skill-menu"><button type="button" className={skillMode === 'auto' ? 'selected' : ''} onClick={() => setSkillMode('auto')}><span><Sparkles size={15} /><strong>自动选择</strong></span><small>使用所有已启用 Skills，由 Agent 判断是否匹配</small>{skillMode === 'auto' && <Check size={15} />}</button><div className="chat-skill-menu-title"><span>手动选择</span><button type="button" onClick={() => { setSkillMode('manual'); setSelectedSkillIds([]); }}>清除</button></div>{skills.length === 0 ? <p>暂无已启用的 Skills</p> : skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={skillMode === 'manual' && selectedSkillIds.includes(skill.id)} onChange={() => { setSkillMode('manual'); toggleSelectedSkill(skill.id); }} /><span><strong>{skill.name}</strong><small>{skill.description || '自定义 Skill'}</small></span></label>)}</div>}</div><small>Enter 发送 · Shift + Enter 换行</small></footer></form></section></section></main>;
}

const emptySkill = { name: '', description: '', trigger: '', instructions: '', enabled: true };

function SkillsWorkspace({ setToast }) {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/api/skills').then(setSkills).catch((error) => setToast({ type: 'error', text: error.message })).finally(() => setLoading(false));
  }, [setToast]);
  useEffect(load, [load]);

  const save = async (form) => {
    setSaving(true);
    try {
      const saved = await api(form.id ? `/api/skills/${form.id}` : '/api/skills', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(form) });
      setSkills((current) => form.id ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      setEditing(null);
      setToast({ type: 'success', text: form.id ? 'Skill 已更新' : 'Skill 已创建' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };
  const toggle = async (skill) => {
    try {
      const saved = await api(`/api/skills/${skill.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !skill.enabled }) });
      setSkills((current) => current.map((item) => item.id === saved.id ? saved : item));
      setToast({ type: 'success', text: saved.enabled ? 'Skill 已启用' : 'Skill 已停用' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const remove = async (skill) => {
    if (!window.confirm(`删除 Skill“${skill.name}”？`)) return;
    try {
      await api(`/api/skills/${skill.id}`, { method: 'DELETE' });
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      setToast({ type: 'success', text: 'Skill 已删除' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const importMarkdown = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (files.length === 0) return;
    setImporting(true);
    try {
      const imported = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.md')) throw new Error(`${file.name} 不是 Markdown 文件`);
        const skill = await api('/api/skills/import', { method: 'POST', body: JSON.stringify({ filename: file.name, content: await file.text() }) });
        imported.push(skill);
      }
      setSkills((current) => [...imported.reverse(), ...current]);
      setToast({ type: 'success', text: `已导入 ${imported.length} 个 Skill` });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setImporting(false); }
  };
  const enabledCount = skills.filter((skill) => skill.enabled).length;

  return <main className="skills-page"><section className="skills-heading"><div><span className="eyebrow">AGENT CAPABILITIES</span><h1>Skills</h1><p>为 Agent 添加专用工作流程。启用后的指令会在对话时自动生效。</p></div><div className="skills-heading-actions"><input ref={importRef} className="skill-file-input" type="file" accept=".md,text/markdown" multiple onChange={importMarkdown} /><button className="secondary-button" onClick={() => importRef.current?.click()} disabled={importing}>{importing ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />}{importing ? '导入中' : '导入 .md'}</button><button className="primary-button" onClick={() => setEditing({ ...emptySkill })}><Plus size={16} />新建 Skill</button></div></section><section className="skills-status"><div><Puzzle size={20} /><span><strong>{skills.length}</strong><small>全部 Skills</small></span></div><div><CircleCheck size={20} /><span><strong>{enabledCount}</strong><small>当前启用</small></span></div><p>配置保存在本机 <code>data/skills.json</code></p></section>{loading ? <div className="skills-loading"><LoaderCircle className="spin" />读取 Skills…</div> : skills.length === 0 ? <section className="skills-empty"><Puzzle size={34} /><h2>还没有 Skills</h2><p>新建 Skill，或导入带 YAML 元数据的 SKILL.md 文件。</p><div className="skills-empty-actions"><button className="secondary-button" onClick={() => importRef.current?.click()}><FileUp size={16} />导入 .md</button><button className="primary-button" onClick={() => setEditing({ ...emptySkill })}><Plus size={16} />创建第一个 Skill</button></div></section> : <section className="skills-list">{skills.map((skill) => <article className={`skill-row ${skill.enabled ? '' : 'disabled'}`} key={skill.id}><span className="skill-icon"><Puzzle size={20} /></span><div className="skill-content"><div><strong>{skill.name}</strong><span className={skill.enabled ? 'enabled' : ''}>{skill.enabled ? '已启用' : '已停用'}</span></div><p>{skill.description || '未填写说明'}</p>{skill.trigger && <small>触发：{skill.trigger}</small>}</div><div className="skill-actions"><button className={`toggle ${skill.enabled ? 'checked' : ''}`} onClick={() => toggle(skill)} title={skill.enabled ? '停用 Skill' : '启用 Skill'} aria-label={skill.enabled ? '停用 Skill' : '启用 Skill'}><i /></button><button className="icon-button" onClick={() => setEditing(skill)} title="编辑 Skill"><Pencil size={16} /></button><button className="icon-button danger" onClick={() => remove(skill)} title="删除 Skill"><Trash2 size={16} /></button></div></article>)}</section>}{editing && <SkillModal skill={editing} saving={saving} onClose={() => setEditing(null)} onSave={save} />}</main>;
}

function SkillModal({ skill, saving, onClose, onSave }) {
  const [form, setForm] = useState(skill);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event) => { event.preventDefault(); onSave(form); };
  return <Modal title={skill.id ? '编辑 Skill' : '新建 Skill'} subtitle="定义适用场景和 Agent 必须遵循的执行指令" onClose={onClose} wide><form className="modal-form skill-form" onSubmit={submit}><div className="field"><label>名称</label><input value={form.name} onChange={update('name')} placeholder="例如：会议纪要整理" maxLength={80} autoFocus /></div><div className="field"><label>说明</label><input value={form.description} onChange={update('description')} placeholder="简要说明这个 Skill 的用途" maxLength={300} /></div><div className="field"><label>触发条件</label><textarea rows={3} value={form.trigger} onChange={update('trigger')} placeholder="例如：当用户提供会议录音转写或要求整理会议内容时" maxLength={300} /></div><div className="field"><label>执行指令</label><textarea className="mono-input" rows={10} value={form.instructions} onChange={update('instructions')} placeholder={'1. 提取议题和关键结论\n2. 列出负责人、截止日期和待办事项\n3. 使用清晰的 Markdown 结构输出'} maxLength={8000} /></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || !form.name.trim() || !form.instructions.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? '保存中' : '保存 Skill'}</button></div></form></Modal>;
}

const emptyScheduledTask = {
  name: '', content: '', contentType: 'message', channel: 'feishu', target: '', qqMessageType: 'private',
  scheduleType: 'once', runAt: '', dailyTime: '09:00', intervalMinutes: 60, enabled: true,
};

function ScheduledTasksWorkspace({ setToast }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState('');
  const load = useCallback(() => {
    setLoading(true);
    api('/api/scheduled-tasks').then(setTasks).catch((error) => setToast({ type: 'error', text: error.message })).finally(() => setLoading(false));
  }, [setToast]);
  useEffect(load, [load]);
  const save = async (form) => {
    setSaving(true);
    try {
      const payload = { ...form, runAt: form.scheduleType === 'once' ? new Date(form.runAt).toISOString() : form.runAt };
      const saved = await api(form.id ? `/api/scheduled-tasks/${form.id}` : '/api/scheduled-tasks', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setTasks((current) => form.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setEditing(null);
      setToast({ type: 'success', text: form.id ? '定时任务已更新' : '定时任务已创建' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };
  const toggle = async (task) => {
    try {
      const saved = await api(`/api/scheduled-tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ ...task, enabled: !task.enabled }) });
      setTasks((current) => current.map((item) => item.id === saved.id ? saved : item));
      setToast({ type: 'success', text: saved.enabled ? '任务已启用' : '任务已暂停' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const run = async (task) => {
    setRunningId(task.id);
    try {
      const saved = await api(`/api/scheduled-tasks/${task.id}/run`, { method: 'POST' });
      setTasks((current) => current.map((item) => item.id === saved.id ? saved : item));
      setToast({ type: 'success', text: '任务执行并推送成功' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setRunningId(''); }
  };
  const remove = async (task) => {
    if (!window.confirm(`删除定时任务“${task.name}”？`)) return;
    try {
      await api(`/api/scheduled-tasks/${task.id}`, { method: 'DELETE' });
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setToast({ type: 'success', text: '定时任务已删除' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '无后续执行';
  const scheduleLabel = (task) => task.scheduleType === 'once' ? `单次 · ${formatDate(task.runAt)}` : task.scheduleType === 'daily' ? `每天 ${task.dailyTime}` : `每 ${task.intervalMinutes} 分钟`;
  const channelLabel = (task) => task.channel === 'qq' ? `QQ ${task.qqMessageType === 'group' ? '群' : '私聊'}` : task.channel === 'wechat' ? '微信' : '飞书';
  const activeCount = tasks.filter((task) => task.enabled).length;
  return <main className="tasks-page"><section className="tasks-heading"><div><span className="eyebrow">BACKGROUND AUTOMATION</span><h1>定时任务</h1><p>服务在后台按计划执行任务，并主动推送到已连接的消息通道。</p></div><button className="primary-button" onClick={() => setEditing({ ...emptyScheduledTask })}><Plus size={16} />新建任务</button></section><section className="tasks-summary"><div><CalendarClock size={20} /><span><strong>{tasks.length}</strong><small>全部任务</small></span></div><div><CircleCheck size={20} /><span><strong>{activeCount}</strong><small>正在调度</small></span></div><p>调度时区：Asia/Shanghai · 后台每 15 秒检查一次</p></section>{loading ? <div className="tasks-empty"><LoaderCircle className="spin" />读取定时任务…</div> : tasks.length === 0 ? <section className="tasks-empty"><CalendarClock size={34} /><h2>还没有定时任务</h2><p>创建单次、每日或固定间隔任务，自动将文本或 Agent 执行结果推送到消息通道。</p><button className="primary-button" onClick={() => setEditing({ ...emptyScheduledTask })}><Plus size={16} />创建第一个任务</button></section> : <section className="tasks-list">{tasks.map((task) => <article className={`task-row ${task.enabled ? '' : 'disabled'}`} key={task.id}><span className="task-icon"><Bell size={20} /></span><div className="task-content"><div><strong>{task.name}</strong><span className={task.lastStatus === 'error' ? 'error' : task.enabled ? 'enabled' : ''}>{task.lastStatus === 'error' ? '上次失败' : task.enabled ? '调度中' : task.scheduleType === 'once' && task.lastStatus === 'success' ? '已完成' : '已暂停'}</span></div><p>{task.content}</p><small><Clock3 size={12} />{scheduleLabel(task)} · 下次 {formatDate(task.nextRunAt)}</small><small><Send size={12} />{channelLabel(task)} · {task.target} · {task.contentType === 'agent' ? 'Agent 执行结果' : '直接文本'}</small>{task.lastError && <em>{task.lastError}</em>}</div><div className="task-actions"><button className={`toggle ${task.enabled ? 'checked' : ''}`} onClick={() => toggle(task)} title={task.enabled ? '暂停任务' : '启用任务'}><i /></button><button className="icon-button" onClick={() => run(task)} disabled={runningId === task.id} title="立即执行">{runningId === task.id ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}</button><button className="icon-button" onClick={() => setEditing(task)} title="编辑任务"><Pencil size={16} /></button><button className="icon-button danger" onClick={() => remove(task)} title="删除任务"><Trash2 size={16} /></button></div></article>)}</section>}{editing && <ScheduledTaskModal task={editing} saving={saving} onClose={() => setEditing(null)} onSave={save} />}</main>;
}

function ScheduledTaskModal({ task, saving, onClose, onSave }) {
  const localRunAt = task.runAt ? new Date(task.runAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : '';
  const [form, setForm] = useState({ ...task, runAt: localRunAt });
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <Modal title={task.id ? '编辑定时任务' : '新建定时任务'} subtitle="后台执行并主动推送到指定消息会话" onClose={onClose} wide><form className="modal-form task-form" onSubmit={(event) => { event.preventDefault(); onSave(form); }}><div className="form-grid"><div className="field full"><label>任务名称</label><input autoFocus value={form.name} onChange={update('name')} placeholder="例如：每日工作简报" /></div><div className="field"><label>内容类型</label><select value={form.contentType} onChange={update('contentType')}><option value="message">直接推送文本</option><option value="agent">执行 Agent 后推送结果</option></select></div><div className="field"><label>推送通道</label><select value={form.channel} onChange={update('channel')}><option value="feishu">飞书</option><option value="wechat">微信</option><option value="qq">QQ</option></select></div>{form.channel === 'qq' && <div className="field"><label>QQ 消息类型</label><select value={form.qqMessageType} onChange={update('qqMessageType')}><option value="private">私聊</option><option value="group">群聊</option></select></div>}<div className={form.channel === 'qq' ? 'field' : 'field full'}><label>推送目标</label><input value={form.target} onChange={update('target')} placeholder={form.channel === 'feishu' ? '飞书 chat_id' : form.channel === 'wechat' ? '微信 user_id' : 'QQ OpenID / 群 OpenID'} /></div><div className="field full"><label>{form.contentType === 'agent' ? 'Agent 任务指令' : '推送内容'}</label><textarea rows={5} value={form.content} onChange={update('content')} placeholder={form.contentType === 'agent' ? '例如：总结今天的系统运行状态并给出三条建议' : '输入要主动推送的消息'} /></div><div className="field"><label>执行计划</label><select value={form.scheduleType} onChange={update('scheduleType')}><option value="once">单次执行</option><option value="daily">每天执行</option><option value="interval">固定间隔</option></select></div>{form.scheduleType === 'once' && <div className="field"><label>执行时间</label><input type="datetime-local" value={form.runAt} onChange={update('runAt')} /></div>}{form.scheduleType === 'daily' && <div className="field"><label>每天执行时间</label><input type="time" value={form.dailyTime} onChange={update('dailyTime')} /></div>}{form.scheduleType === 'interval' && <div className="field"><label>间隔分钟数</label><input type="number" min="1" max="525600" value={form.intervalMinutes} onChange={update('intervalMinutes')} /></div>}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || !form.name.trim() || !form.content.trim() || !form.target.trim() || (form.scheduleType === 'once' && !form.runAt)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? '保存中' : '保存任务'}</button></div></form></Modal>;
}

function LogsWorkspace({ logs, setLogs, setToast }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const visibleLogs = logs.filter((log) => {
    if (filter !== 'all' && log.type !== filter) return false;
    const search = query.trim().toLowerCase();
    return !search || `${log.title} ${log.detail || ''}`.toLowerCase().includes(search);
  });
  const counts = logs.reduce((result, log) => ({ ...result, [log.type]: (result[log.type] || 0) + 1 }), {});
  const refresh = async () => {
    setRefreshing(true);
    try { setLogs(await api('/api/logs?limit=500')); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setRefreshing(false); }
  };
  const clear = async () => {
    if (!window.confirm('清空全部运行日志？此操作会同时清空本机日志文件。')) return;
    setClearing(true);
    try {
      await api('/api/logs', { method: 'DELETE' });
      setLogs([]);
      setToast({ type: 'success', text: '运行日志已清空' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setClearing(false); }
  };
  const formatLogTime = (log) => log.createdAt
    ? new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })
    : log.time;
  return <main className="logs-page"><section className="logs-heading"><div><span className="eyebrow">RUNTIME EVENTS</span><h1>运行日志</h1><p>来自本机 Agent 的真实事件，实时写入并保存在 data/runtime.ndjson。</p></div><div className="logs-heading-actions"><button className="secondary-button" onClick={refresh} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}刷新</button><button className="danger-outline" onClick={clear} disabled={clearing || logs.length === 0}>{clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}清空日志</button></div></section><section className="logs-summary"><div><span>全部事件</span><strong>{logs.length}</strong></div><div className="success"><span>成功</span><strong>{counts.success || 0}</strong></div><div className="info"><span>信息</span><strong>{counts.info || 0}</strong></div><div className="error"><span>错误</span><strong>{counts.error || 0}</strong></div></section><section className="logs-panel"><div className="logs-toolbar"><div className="log-filters">{[['all', '全部'], ['success', '成功'], ['info', '信息'], ['error', '错误']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或详情" aria-label="搜索运行日志" /></div><div className="runtime-log-list">{visibleLogs.length === 0 ? <div className="runtime-log-empty"><Database size={25} /><strong>没有匹配的运行记录</strong><span>执行电脑操作、终端命令或连接机器人后，事件会实时出现在这里。</span></div> : visibleLogs.map((log) => <article className="runtime-log-row" key={log.id}><span className={`runtime-log-icon ${log.type}`}>{log.type === 'success' ? <CircleCheck size={17} /> : log.type === 'error' ? <CircleAlert size={17} /> : <Activity size={17} />}</span><div><div className="runtime-log-title"><strong>{log.title}</strong><span className={log.type}>{log.type === 'success' ? '成功' : log.type === 'error' ? '错误' : '信息'}</span></div>{log.detail && <p>{log.detail}</p>}</div><time dateTime={log.createdAt || ''}>{formatLogTime(log)}</time></article>)}</div><footer className="runtime-log-footer"><span><i />实时连接</span><span>显示 {visibleLogs.length} / {logs.length} 条</span></footer></section></main>;
}

function ComputerControl({ running, runAction, setActionModal }) {
  return <main className="tool-page"><section className="tool-heading"><div><span className="eyebrow">LOCAL COMPUTER</span><h1>电脑控制</h1><p>通过本机 Agent 立即执行桌面操作。</p></div><button className="danger-outline" onClick={() => runAction({ type: 'lock' })}><LockKeyhole size={16} />锁定屏幕</button></section><section className="control-grid">{shortcuts.map((item) => { const Icon = item.icon; return <button key={item.type} className={`control-card ${item.tone}`} onClick={() => item.type === 'screenshot' ? runAction({ type: 'screenshot' }) : setActionModal(item.type)} disabled={Boolean(running)}><span className="control-card-icon">{running === item.type ? <LoaderCircle className="spin" size={24} /> : <Icon size={24} />}</span><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={18} /></button>; })}</section><section className="tool-note"><CircleCheck size={17} /><div><strong>本机控制服务正在运行</strong><span>所有操作通过 127.0.0.1 发送到当前设备，不经过远程控制服务器。</span></div></section></main>;
}

function RemoteDesktop({ nodeId, status, setToast }) {
  const [connection, setConnection] = useState('checking');
  const [username, setUsername] = useState(status?.username || '');
  const [password, setPassword] = useState('');
  const [credentialTypes, setCredentialTypes] = useState(['password']);
  const [message, setMessage] = useState('正在检测本机 VNC 服务');
  const [scaleViewport, setScaleViewport] = useState(true);
  const [vncInfo, setVncInfo] = useState(null);
  const viewerRef = useRef(null);
  const canvasRef = useRef(null);
  const rfbRef = useRef(null);
  const authenticationFailedRef = useRef(false);
  const pendingCredentialsRef = useRef(null);

  const disconnect = useCallback(() => {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    if (canvasRef.current) canvasRef.current.replaceChildren();
    setConnection('disconnected');
    setMessage('VNC 会话已断开');
  }, []);

  const connect = useCallback(async () => {
    setConnection('connecting');
    setMessage('正在连接 VNC 服务');
    authenticationFailedRef.current = false;
    try {
      const vnc = await api(`/api/vnc/status?nodeId=${encodeURIComponent(nodeId)}`);
      setVncInfo(vnc);
      if (!vnc.available) {
        setConnection('unavailable');
        setMessage(vnc.supported
          ? vnc.installed ? (vnc.error || '项目内 VNC 服务尚未启动') : '项目内尚未安装 Linux VNC，请在项目目录执行 npm run vnc:install'
          : '本机 VNC 服务未启动，请在 macOS“系统设置 > 通用 > 共享”中开启“屏幕共享”');
        return;
      }
      if (!canvasRef.current) return;
      canvasRef.current.replaceChildren();
      const { ticket } = await api('/api/vnc/ticket', { method: 'POST', body: JSON.stringify({ nodeId }) });
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const credentials = pendingCredentialsRef.current;
      pendingCredentialsRef.current = null;
      const rfb = new RFB(
        canvasRef.current,
        `${protocol}//${window.location.host}/api/vnc?ticket=${encodeURIComponent(ticket)}`,
        credentials ? { credentials } : undefined,
      );
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      rfb.background = '#15181c';
      rfb.addEventListener('connect', () => { authenticationFailedRef.current = false; setPassword(''); setConnection('connected'); setMessage('VNC 已连接'); });
      rfb.addEventListener('disconnect', (event) => {
        rfbRef.current = null;
        if (authenticationFailedRef.current) return;
        setConnection('disconnected');
        setMessage(event.detail.clean ? 'VNC 会话已断开' : 'VNC 连接中断，请检查屏幕共享设置');
      });
      rfb.addEventListener('credentialsrequired', (event) => {
        const types = event.detail?.types || ['password'];
        setCredentialTypes(types);
        setConnection('credentials');
        setMessage(types.includes('username') ? '请输入 macOS 登录用户名和密码' : '请输入屏幕共享密码');
      });
      rfb.addEventListener('securityfailure', (event) => {
        authenticationFailedRef.current = true;
        setPassword('');
        setConnection('credentials');
        setMessage(event.detail.reason || 'VNC 密码验证失败，请重新输入');
      });
      rfbRef.current = rfb;
    } catch (error) {
      setConnection('unavailable');
      setMessage(error.message);
      setToast({ type: 'error', text: error.message });
    }
  }, [nodeId, setToast]);

  useEffect(() => {
    connect();
    return () => {
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [connect]);

  useEffect(() => { if (rfbRef.current) rfbRef.current.scaleViewport = scaleViewport; }, [scaleViewport]);
  useEffect(() => { setUsername(status?.username || ''); }, [nodeId, status?.username]);

  const submitPassword = (event) => {
    event.preventDefault();
    if (rfbRef.current && password) {
      authenticationFailedRef.current = false;
      rfbRef.current.sendCredentials({ username, password });
      setConnection('connecting');
      setMessage('正在验证 VNC 密码');
    } else if (password) {
      pendingCredentialsRef.current = { username, password };
      connect();
    }
  };

  const startVnc = async () => {
    setConnection('connecting');
    setMessage('正在启动项目内 VNC 服务');
    try {
      const result = await api('/api/vnc/start', { method: 'POST', body: JSON.stringify({ nodeId }) });
      setVncInfo(result);
      if (!result.available) {
        setConnection('unavailable');
        setMessage(result.error || '项目内 VNC 服务启动失败');
        return;
      }
      await connect();
    } catch (error) {
      setConnection('unavailable');
      setMessage(error.message);
    }
  };

  const requiresUsername = credentialTypes.includes('username');
  return <main className="remote-desktop-page"><section className="remote-desktop-heading"><div><span className="eyebrow">NO VNC DESKTOP</span><h1>远程桌面</h1><p>{status?.hostname || '当前设备'} · 内置 noVNC 安全代理</p></div><div className="remote-desktop-actions"><span className={`desktop-live ${connection === 'connected' ? 'active' : ''}`}><i />{connection === 'connected' ? '已连接' : connection === 'connecting' || connection === 'checking' ? '连接中' : '未连接'}</span><button className="secondary-button" onClick={connection === 'connected' ? disconnect : connect}>{connection === 'connected' ? <Pause size={15} /> : <Play size={15} />}{connection === 'connected' ? '断开' : '连接'}</button><button className="secondary-button" onClick={() => { disconnect(); setTimeout(connect, 50); }}><RefreshCw size={15} />重连</button><button className="secondary-button" onClick={() => viewerRef.current?.requestFullscreen?.()}><Maximize2 size={15} />全屏</button></div></section><section className="remote-desktop-shell"><div className="remote-desktop-toolbar vnc-toolbar"><label><input type="checkbox" checked={scaleViewport} onChange={(event) => setScaleViewport(event.target.checked)} />适应窗口</label><span>鼠标、键盘和剪贴板由 VNC 会话直接接管</span></div><div className="remote-desktop-viewer vnc-viewer" ref={viewerRef}><div className="vnc-canvas" ref={canvasRef} />{connection !== 'connected' && <div className="vnc-state"><ScreenShare size={28} /><strong>{message}</strong>{connection === 'credentials' && <form className={requiresUsername ? 'requires-username' : ''} onSubmit={submitPassword}>{requiresUsername && <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="macOS 用户名" autoComplete="username" autoFocus />}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={requiresUsername ? 'macOS 登录密码' : '屏幕共享密码'} autoComplete="current-password" autoFocus={!requiresUsername} /><button disabled={!password || (requiresUsername && !username.trim())}><LockKeyhole size={15} />连接</button></form>}{connection === 'unavailable' && <div className="vnc-state-actions">{vncInfo?.supported && vncInfo?.installed && <button className="primary-button" onClick={startVnc}><Play size={15} />启动内置 VNC</button>}<button className="secondary-button" onClick={connect}><RefreshCw size={15} />重新检测</button></div>}{['checking', 'connecting'].includes(connection) && <LoaderCircle className="spin" size={20} />}</div>}</div><footer className="remote-desktop-footer"><span><ShieldCheck size={14} />VNC 流量仅通过已登录的 BrightBot 会话代理</span><time>{vncInfo?.managed ? '项目内 VNC · ' : ''}127.0.0.1:5900</time></footer></section></main>;
}

function CommandWorkspace({ status, nodeId, setToast }) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState([]);
  const [executing, setExecuting] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [cwd, setCwd] = useState('~');
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  const sessionIdRef = useRef(globalThis.crypto?.randomUUID?.() || `terminal-${Date.now()}`);

  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' }); }, [history, executing]);
  useEffect(() => {
    if (!executing) inputRef.current?.focus();
  }, [executing]);

  const execute = async (event) => {
    event?.preventDefault();
    const value = command.trim();
    if (!value || executing) return;
    if (value === 'clear') { setHistory([]); setCommand(''); setHistoryIndex(-1); return; }
    setCommand('');
    setHistoryIndex(-1);
    setExecuting(true);
    const startedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try {
      const result = await api('/api/terminal/execute', { method: 'POST', body: JSON.stringify({ sessionId: sessionIdRef.current, command: value, nodeId }) });
      setHistory((current) => [...current, { id: Date.now(), command: value, output: result.output, time: startedAt, ok: result.ok, cwd }]);
      setCwd(result.cwdLabel || cwd);
    } catch (error) {
      setHistory((current) => [...current, { id: Date.now(), command: value, output: error.message, time: startedAt, ok: false, cwd }]);
      setToast({ type: 'error', text: error.message });
    } finally { setExecuting(false); }
  };
  const recallHistory = (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || history.length === 0) return;
    event.preventDefault();
    const commands = history.map((entry) => entry.command).reverse();
    const next = event.key === 'ArrowUp' ? Math.min(historyIndex + 1, commands.length - 1) : Math.max(historyIndex - 1, -1);
    setHistoryIndex(next);
    setCommand(next === -1 ? '' : commands[next]);
  };
  const host = status?.hostname?.split('.')[0] || 'localhost';
  return <main className="tool-page command-page"><section className="tool-heading"><div><span className="eyebrow">LOCAL TERMINAL</span><h1>网页终端</h1><p>终端会话会保留当前工作目录，单条命令最长运行 20 秒。</p></div></section><section className="web-terminal" onClick={() => inputRef.current?.focus()}><header className="terminal-titlebar"><div className="window-dots"><i /><i /><i /></div><strong><Terminal size={14} />{host} — zsh</strong><button onClick={() => setHistory([])} disabled={history.length === 0}>清屏</button></header><div className="terminal-output" ref={outputRef}><div className="terminal-welcome">BrightBot Web Terminal<br />输入命令并按 Enter 执行，使用 ↑ ↓ 浏览历史，输入 clear 清屏。</div>{history.map((entry) => <div className={`terminal-entry ${entry.ok ? '' : 'failed'}`} key={entry.id}><div className="terminal-command"><span>user@{host} {entry.cwd} %</span> {entry.command}</div>{entry.output && <pre>{entry.output}</pre>}</div>)}{executing && <div className="terminal-running"><LoaderCircle className="spin" size={13} />正在执行…</div>}</div><form className="terminal-input-row" onSubmit={execute}><span>user@{host} {cwd} %</span><input ref={inputRef} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={recallHistory} disabled={executing} autoFocus autoComplete="off" spellCheck="false" aria-label="终端命令" /></form></section><div className="command-presets terminal-presets"><span>快捷输入</span>{['pwd', 'ls -la', 'whoami', 'uname -a'].map((item) => <button key={item} onClick={() => { setCommand(item); inputRef.current?.focus(); }}>{item}</button>)}</div></main>;
}

function AgentWorkspace({ status, nodeId, refreshStatus, setToast }) {
  const [selected, setSelected] = useState('qq');
  const [bots, setBots] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [addingBot, setAddingBot] = useState(false);
  const [form, setForm] = useState({ qqAppId: '', qqAppSecret: '', qqAllowedOpenids: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [wechatLogin, setWechatLogin] = useState({ status: status?.wechatConnected ? 'connected' : 'idle', image: '' });
  const [wechatLoading, setWechatLoading] = useState(false);
  const [feishuLogin, setFeishuLogin] = useState({ status: status?.feishuConnected ? 'connected' : 'idle', image: '', interval: 5 });
  const [feishuLoading, setFeishuLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setSelectedBotId('');
    api(`/api/bots?reveal=1&nodeId=${encodeURIComponent(nodeId)}`).then((list) => {
      setBots(list);
      const current = list.find((bot) => bot.active) || list[0];
      if (current) {
        setSelectedBotId(current.id);
        setSelected(current.channel);
        if (current.channel === 'qq') setForm({ qqAppId: current.config.appId || '', qqAppSecret: current.config.appSecret || '', qqAllowedOpenids: current.config.allowedOpenids || '' });
      }
    }).catch((error) => setToast({ type: 'error', text: error.message })).finally(() => setLoading(false));
  }, [nodeId, setToast]);

  useEffect(() => {
    if (!['wait', 'scaned', 'scanned'].includes(wechatLogin.status)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const result = await api(`/api/wechat/login/status?profileId=${encodeURIComponent(selectedBotId)}`);
        if (!active) return;
        setWechatLogin(result);
        if (result.status === 'connected') {
          setToast({ type: 'success', text: '微信 iLink 已连接' });
          refreshStatus();
        } else if (!['expired', 'denied'].includes(result.status)) setTimeout(poll, 800);
      } catch (error) { if (active) setToast({ type: 'error', text: error.message }); }
    };
    poll();
    return () => { active = false; };
  }, [wechatLogin.status, selectedBotId, refreshStatus, setToast]);

  useEffect(() => {
    if (!['pending', 'slow_down', 'connecting'].includes(feishuLogin.status)) return undefined;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api(`/api/feishu/login/status?profileId=${encodeURIComponent(selectedBotId)}`);
        if (!active) return;
        setFeishuLogin((current) => ({ ...current, ...result }));
        if (result.status === 'connected' || result.connected) {
          setToast({ type: 'success', text: '飞书机器人已连接' });
          refreshStatus();
        }
      } catch (error) { if (active) setToast({ type: 'error', text: error.message }); }
    }, Math.max(2000, Number(feishuLogin.interval || 5) * 1000));
    return () => { active = false; clearTimeout(timer); };
  }, [feishuLogin.status, feishuLogin.interval, selectedBotId, refreshStatus, setToast]);

  useEffect(() => {
    if (selected !== 'feishu') return undefined;
    let active = true;
    const sync = async () => {
      try {
        const result = await api(`/api/feishu/login/status?profileId=${encodeURIComponent(selectedBotId)}`);
        if (!active) return;
        setFeishuLogin((current) => ({ ...current, ...result, image: result.connected ? '' : (result.image || current.image) }));
        if (result.connected) await refreshStatus();
      } catch {
        // The main status refresh handles transient service errors.
      }
    };
    sync();
    const timer = setInterval(sync, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selected, selectedBotId, refreshStatus]);

  useEffect(() => {
    if (status?.feishuConnected) setFeishuLogin((current) => ({ ...current, status: 'connected', image: '' }));
  }, [status?.feishuConnected]);

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggleSecret = () => setShowSecret((value) => !value);
  const saveQQ = async (connect = false) => {
    connect ? setTesting(true) : setSaving(true);
    try {
      const saved = await api(`/api/bots/${selectedBotId}`, { method: 'PUT', body: JSON.stringify({ config: { appId: form.qqAppId, appSecret: form.qqAppSecret, allowedOpenids: form.qqAllowedOpenids } }) });
      setForm({ qqAppId: saved.config.appId || '', qqAppSecret: saved.config.appSecret || '', qqAllowedOpenids: saved.config.allowedOpenids || '' });
      await api(`/api/bots/${selectedBotId}/activate`, { method: 'POST' });
      if (connect) {
        const result = await api('/api/qq/test', { method: 'POST', body: JSON.stringify({ profileId: selectedBotId }) });
        if (!result.connected) throw new Error(result.error || 'QQ Gateway 连接失败');
      }
      await refreshStatus();
      setToast({ type: 'success', text: connect ? 'QQ 官方机器人已连接' : 'QQ 机器人配置已保存' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); setTesting(false); }
  };
  const selectBot = async (bot) => {
    try {
      setSelectedBotId(bot.id);
      setSelected(bot.channel);
      if (bot.channel === 'qq') setForm({ qqAppId: bot.config.appId || '', qqAppSecret: bot.config.appSecret || '', qqAllowedOpenids: bot.config.allowedOpenids || '' });
      setBots(await api(`/api/bots?reveal=1&nodeId=${encodeURIComponent(nodeId)}`));
      setWechatLogin({ status: bot.channel === 'wechat' ? bot.status : 'idle', image: '' });
      setFeishuLogin({ status: bot.channel === 'feishu' && bot.config.appId ? 'connecting' : 'idle', image: '', interval: 5 });
      await refreshStatus();
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const createBot = async ({ name, channel }) => {
    try {
      const bot = await api('/api/bots', { method: 'POST', body: JSON.stringify({ name, channel, nodeId }) });
      setAddingBot(false);
      await selectBot(bot);
      setToast({ type: 'success', text: `${bot.name} 已创建` });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const deleteBot = async () => {
    const bot = bots.find((item) => item.id === selectedBotId);
    if (!bot || !window.confirm(`删除机器人“${bot.name}”？`)) return;
    try {
      await api(`/api/bots/${bot.id}`, { method: 'DELETE' });
      const list = await api(`/api/bots?reveal=1&nodeId=${encodeURIComponent(nodeId)}`);
      setBots(list);
      const next = list.find((item) => item.active) || list[0];
      if (next) await selectBot(next);
      setToast({ type: 'success', text: '机器人实例已删除' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
  };
  const startWechat = async () => {
    setWechatLoading(true);
    try { setWechatLogin(await api('/api/wechat/login', { method: 'POST', body: JSON.stringify({ profileId: selectedBotId }) })); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setWechatLoading(false); }
  };
  const logoutWechat = async () => {
    await api('/api/wechat/logout', { method: 'POST', body: JSON.stringify({ profileId: selectedBotId }) });
    setWechatLogin({ status: 'idle', image: '' });
    await refreshStatus();
    setToast({ type: 'success', text: '微信渠道已退出' });
  };
  const startFeishu = async () => {
    setFeishuLoading(true);
    try { setFeishuLogin(await api('/api/feishu/login', { method: 'POST', body: JSON.stringify({ profileId: selectedBotId, domain: 'https://open.feishu.cn' }) })); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setFeishuLoading(false); }
  };
  const logoutFeishu = async () => {
    await api('/api/feishu/logout', { method: 'POST', body: JSON.stringify({ profileId: selectedBotId }) });
    setFeishuLogin({ status: 'idle', image: '', interval: 5 });
    await refreshStatus();
    setToast({ type: 'success', text: '飞书机器人已退出' });
  };

  const selectedBot = bots.find((bot) => bot.id === selectedBotId);
  const qqOnline = selectedBot?.channel === 'qq' && selectedBot.status === 'connected';
  const wechatOnline = selectedBot?.channel === 'wechat' && (selectedBot.status === 'connected' || wechatLogin.status === 'connected');
  const feishuOnline = selectedBot?.channel === 'feishu' && (selectedBot.status === 'connected' || feishuLogin.status === 'connected');
  const channels = {
    qq: { logo: 'Q', logoClass: 'qq', name: 'QQ 官方机器人', subtitle: 'QQ Open Platform Gateway', state: qqOnline ? '已连接' : '待连接', code: 'qq_official' },
    wechat: { logo: '微', logoClass: 'wechat', name: '微信机器人', subtitle: '微信 iLink 扫码渠道', state: wechatOnline ? '已连接' : '待扫码', code: 'weixin_ilink' },
    feishu: { logo: '飞', logoClass: 'feishu', name: '飞书机器人', subtitle: '飞书开放平台长连接', state: feishuOnline ? '已连接' : '待扫码', code: 'feishu_lark' },
  };
  const current = channels[selected];
  return <main className="config-page"><section className="config-frame"><aside className="config-list"><div className="config-list-head"><h2>机器人</h2><button onClick={() => setAddingBot(true)}><Plus size={14} />新增</button></div>{bots.map((bot) => { const channel = channels[bot.channel]; const online = bot.status === 'connected'; return <button key={bot.id} className={`config-list-item ${selectedBotId === bot.id ? 'selected' : ''}`} onClick={() => selectBot(bot)}><span className={`config-logo ${channel.logoClass}`}>{channel.logo}</span><span><strong>{bot.name}</strong><small><i className={online ? '' : 'offline'} />{online ? '已连接' : bot.status === 'connecting' ? '连接中' : '未连接'} · {channel.code}</small></span>{online && <CircleCheck size={15} />}</button>; })}</aside><section className="config-detail"><div className="config-detail-head"><div className="detail-title"><span className={`config-logo ${current.logoClass}`}>{current.logo}</span><div><h1>{bots.find((bot) => bot.id === selectedBotId)?.name || current.name}</h1><p>{current.subtitle} · {current.state}</p></div></div><div className="bot-detail-actions"><button className="icon-button danger" onClick={deleteBot} title="删除机器人"><Trash2 size={16} /></button>{selected === 'qq' && <button className="save-button" onClick={() => saveQQ(false)} disabled={saving || loading}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : '保存更改'}</button>}</div></div><div className="config-scroll">{selected === 'qq' ? <>{loading ? <div className="modal-loading"><LoaderCircle className="spin" />读取配置…</div> : <><div className="section-title"><div><h2>QQ 开放平台接入</h2><p>配置真实凭证并连接官方 WebSocket Gateway。</p></div><span className={`service-status ${qqOnline ? 'healthy' : ''}`}><i />{qqOnline ? '在线' : '离线'}</span></div><SettingRow title="AppID" description="QQ 开放平台机器人 AppID"><input value={form.qqAppId} onChange={update('qqAppId')} /></SettingRow><SettingRow title="AppSecret" description="用于获取令牌和 Gateway 身份验证"><div className="secret-input"><input type={showSecret ? 'text' : 'password'} value={form.qqAppSecret} onChange={update('qqAppSecret')} /><button type="button" onClick={toggleSecret} title={showSecret ? '隐藏 AppSecret' : '查看 AppSecret'} aria-label={showSecret ? '隐藏 AppSecret' : '查看 AppSecret'}>{showSecret ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></SettingRow><SettingRow title="允许控制的用户" description="填写用户 OpenID，多个值使用英文逗号分隔"><input value={form.qqAllowedOpenids} onChange={update('qqAllowedOpenids')} placeholder="USER_OPENID_1, USER_OPENID_2" /></SettingRow><SettingRow title="消息能力" description="支持私聊、群聊 @ 和频道消息"><span className="capability-state"><CircleCheck size={16} />已启用</span></SettingRow><div className="inline-actions"><button className="secondary-button" onClick={() => saveQQ(true)} disabled={testing}>{testing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{testing ? '连接中' : '保存并验证连接'}</button></div></>}</> : selected === 'wechat' ? <><div className="section-title"><div><h2>微信 iLink 扫码接入</h2><p>个人微信扫码确认后，私聊消息直接进入智能 Agent。</p></div><span className={`service-status ${wechatOnline ? 'healthy' : ''}`}><i />{wechatOnline ? '在线' : '离线'}</span></div><div className="wechat-config-panel">{wechatOnline ? <div className="wechat-real-state"><CircleCheck size={34} /><h3>微信渠道已连接</h3><p>上下文记忆、正在输入状态和 Computer Use 均已启用。</p><button className="secondary-button" onClick={logoutWechat}>退出微信渠道</button></div> : wechatLogin.image ? <div className="wechat-real-state"><img src={wechatLogin.image} alt="微信登录二维码" /><h3>使用微信扫描二维码</h3><p>{wechatLogin.status === 'expired' ? '二维码已过期，请重新生成。' : '扫码后在手机微信中确认登录。'}</p>{wechatLogin.status === 'expired' && <button className="primary-button" onClick={startWechat}>重新生成二维码</button>}</div> : <div className="wechat-real-state"><span className="config-logo wechat large">微</span><h3>连接个人微信</h3><p>无需填写服务地址或访问令牌，直接通过 iLink 扫码。</p><button className="primary-button" onClick={startWechat} disabled={wechatLoading}>{wechatLoading ? <LoaderCircle className="spin" size={16} /> : <MessageCircle size={16} />}{wechatLoading ? '生成中' : '生成登录二维码'}</button></div>}</div></> : <><div className="section-title"><div><h2>飞书扫码接入</h2><p>扫描二维码自动创建应用，并通过官方长连接接收消息。</p></div><span className={`service-status ${feishuOnline ? 'healthy' : ''}`}><i />{feishuOnline ? '在线' : '离线'}</span></div><div className="wechat-config-panel feishu-panel">{feishuOnline ? <div className="wechat-real-state feishu-state"><CircleCheck size={34} /><h3>飞书机器人已连接</h3><p>私聊和群聊 @ 消息会直接进入 BrightBot Agent。</p><button className="secondary-button" onClick={logoutFeishu}>退出飞书渠道</button></div> : feishuLogin.image ? <div className="wechat-real-state feishu-state"><img src={feishuLogin.image} alt="飞书授权二维码" /><h3>使用飞书扫描二维码</h3><p>{feishuLogin.status === 'expired' ? '二维码已过期，请重新生成。' : feishuLogin.status === 'denied' ? '授权已取消，请重新生成。' : '在手机飞书中确认后将自动完成应用创建和连接。'}</p>{['expired', 'denied'].includes(feishuLogin.status) && <button className="primary-button" onClick={startFeishu}>重新生成二维码</button>}</div> : <div className="wechat-real-state feishu-state"><span className="config-logo feishu large">飞</span><h3>连接飞书机器人</h3><p>无需手动填写 App ID 或 App Secret，直接扫码完成接入。</p><button className="primary-button" onClick={startFeishu} disabled={feishuLoading}>{feishuLoading ? <LoaderCircle className="spin" size={16} /> : <MessageCircle size={16} />}{feishuLoading ? '生成中' : '生成授权二维码'}</button></div>}</div></>}</div></section></section>{addingBot && <AddBotModal onClose={() => setAddingBot(false)} onCreate={createBot} />}</main>;
}

function AddBotModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('qq');
  const submit = (event) => { event.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), channel }); };
  return <Modal title="新增机器人" subtitle="创建独立的机器人实例" onClose={onClose}><form className="modal-form" onSubmit={submit}><label>机器人名称</label><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 客服飞书机器人" /><label>机器人渠道</label><select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="qq">QQ 官方机器人</option><option value="wechat">微信机器人</option><option value="feishu">飞书机器人</option></select><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim()}><Plus size={15} />创建机器人</button></div></form></Modal>;
}

function ModelWorkspace({ setToast }) {
  const [form, setForm] = useState({ llmProviderName: '自定义提供商', llmBaseUrl: '', llmApiKey: '', llmModel: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api('/api/settings?reveal=1').then((data) => setForm({ llmProviderName: data.llmProviderName || '自定义提供商', llmBaseUrl: data.llmBaseUrl || '', llmApiKey: data.llmApiKey || '', llmModel: data.llmModel || '' })).catch((error) => setToast({ type: 'error', text: error.message })).finally(() => setLoading(false));
  }, [setToast]);

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggleKey = () => setShowKey((value) => !value);
  const save = async () => {
    setSaving(true);
    try { const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify(form) }); setForm((current) => ({ ...current, ...saved })); setToast({ type: 'success', text: '模型配置已保存' }); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(form) }); const result = await api('/api/llm/test', { method: 'POST' }); setToast({ type: 'success', text: `模型连接成功：${result.reply}` }); }
    catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setTesting(false); }
  };
  const modelVisible = !query.trim() || form.llmModel.toLowerCase().includes(query.trim().toLowerCase());

  return <main className="config-page"><div className="capability-tabs"><span className="active"><MessageCircle size={15} />对话模型</span></div><section className="config-frame model-frame"><aside className="config-list"><div className="config-list-head"><h2>提供商</h2></div><div className="config-list-item selected"><span className="provider-logo">◎</span><span><strong>{form.llmProviderName || '自定义提供商'}</strong><small>{form.llmBaseUrl || '尚未配置'}</small></span></div></aside><section className="config-detail"><div className="config-detail-head"><div className="detail-title"><div><h1>{form.llmProviderName || '自定义提供商'}</h1><p>{form.llmBaseUrl || 'OpenAI 兼容接口'}</p></div></div><button className="save-button" onClick={save} disabled={saving || loading}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : '保存配置'}</button></div><div className="config-scroll">{loading ? <div className="modal-loading"><LoaderCircle className="spin" />读取配置…</div> : <><div className="section-title"><div><h2>设置</h2></div></div><SettingRow title="提供商名称" description="用于在控制台中识别该模型服务"><input value={form.llmProviderName} onChange={update('llmProviderName')} placeholder="例如 OpenAI、千里清秋" /></SettingRow><SettingRow title="API Key" description="模型服务的 API 密钥"><div className="secret-input"><input type={showKey ? 'text' : 'password'} value={form.llmApiKey} onChange={update('llmApiKey')} placeholder="sk-..." /><button type="button" onClick={toggleKey} title={showKey ? '隐藏 API Key' : '查看 API Key'} aria-label={showKey ? '隐藏 API Key' : '查看 API Key'}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></SettingRow><SettingRow title="API Base URL" description="OpenAI 兼容 API 端点"><input value={form.llmBaseUrl} onChange={update('llmBaseUrl')} placeholder="https://api.openai.com/v1" /></SettingRow><SettingRow title="模型名称" description="请求使用的模型 ID"><input value={form.llmModel} onChange={update('llmModel')} placeholder="gpt-4o-mini" /></SettingRow><div className="model-section"><div><h2>已配置模型</h2><p>{form.llmModel ? '可用模型 1' : '可用模型 0'}</p></div><div className="model-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或 ID" /><button type="button" onClick={test} disabled={testing || !form.llmBaseUrl || !form.llmModel}>{testing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{testing ? '测试中' : '测试连接'}</button></div>{form.llmModel && modelVisible && <div className="model-item"><div><strong>{form.llmProviderName}/{form.llmModel}</strong><small>{form.llmBaseUrl}</small></div><span className="model-ready"><i />已配置</span></div>}{form.llmModel && !modelVisible && <div className="model-empty">没有匹配的模型</div>}</div></>}</div></section></section></main>;
}

const mbtiTypes = ['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP', 'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP'];

function ProfileWorkspace({ setToast }) {
  const defaultPrompt = '你是 BrightBot，一个简洁、可靠的本机智能助手。请使用中文回答，除非用户要求使用其他语言。';
  const [form, setForm] = useState({ systemPrompt: defaultPrompt, mbti: 'INTJ' });
  const [oidc, setOidc] = useState({ issuer: 'https://auth.brightweb.top/oidc', clientId: '', clientSecret: '', redirectUri: '', allowedUsers: '' });
  const [showOidcSecret, setShowOidcSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api('/api/settings'), api('/api/auth/brightweb/config')])
      .then(([data, oidcData]) => { setForm({ systemPrompt: data.systemPrompt || defaultPrompt, mbti: data.mbti || 'INTJ' }); setOidc(oidcData); })
      .catch((error) => setToast({ type: 'error', text: error.message }))
      .finally(() => setLoading(false));
  }, [setToast]);

  const save = async () => {
    setSaving(true);
    try {
      const [saved, savedOidc] = await Promise.all([api('/api/settings', { method: 'PUT', body: JSON.stringify(form) }), api('/api/auth/brightweb/config', { method: 'PUT', body: JSON.stringify(oidc) })]);
      setForm({ systemPrompt: saved.systemPrompt, mbti: saved.mbti });
      setOidc(savedOidc);
      setToast({ type: 'success', text: '配置文件已保存' });
    } catch (error) { setToast({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };

  return <main className="profile-page"><section className="profile-heading"><div><span className="eyebrow">AGENT PROFILE</span><h1>配置文件</h1><p>配置 Agent 人格与 BrightWeb 统一认证。</p></div><button className="save-button" onClick={save} disabled={saving || loading}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : '保存配置'}</button></section><section className="profile-panel">{loading ? <div className="modal-loading"><LoaderCircle className="spin" />读取配置…</div> : <><div className="profile-section-label"><ShieldCheck size={16} />BrightWeb 统一认证</div><SettingRow title="认证端点" description="BrightWeb OpenID Connect Issuer"><input value={oidc.issuer} disabled /></SettingRow><SettingRow title="Client ID" description="在 BrightWeb 认证中心创建应用后获得"><input value={oidc.clientId} onChange={(event) => setOidc((current) => ({ ...current, clientId: event.target.value }))} placeholder="BrightWeb Client ID" /></SettingRow><SettingRow title="Client Secret" description="公共客户端可留空，机密客户端填写应用密钥"><div className="secret-input"><input type={showOidcSecret ? 'text' : 'password'} value={oidc.clientSecret} onChange={(event) => setOidc((current) => ({ ...current, clientSecret: event.target.value }))} placeholder="可留空" /><button type="button" onClick={() => setShowOidcSecret((value) => !value)}>{showOidcSecret ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></SettingRow><SettingRow title="回调地址" description="需要完整添加到 BrightWeb 应用的 Redirect URI"><input value={oidc.redirectUri} onChange={(event) => setOidc((current) => ({ ...current, redirectUri: event.target.value }))} /></SettingRow><SettingRow title="登录白名单" description="填写 BrightWeb 邮箱、用户名或用户 ID，每行或逗号分隔；为空时拒绝所有用户"><textarea className="auth-allowlist" rows={5} value={oidc.allowedUsers} onChange={(event) => setOidc((current) => ({ ...current, allowedUsers: event.target.value }))} placeholder="user@example.com" /></SettingRow><div className="profile-section-label"><FileCog size={16} />Agent 配置</div><SettingRow title="MBTI" description="决定 Agent 默认的沟通风格，不影响任务准确性和工具能力"><select value={form.mbti} onChange={(event) => setForm((current) => ({ ...current, mbti: event.target.value }))}>{mbtiTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></SettingRow><SettingRow title="Agent Prompt" description="设置 Agent 的角色、语气和业务规则，保存后对新请求立即生效"><div className="prompt-control"><textarea rows={12} maxLength={20000} value={form.systemPrompt} onChange={(event) => setForm((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder="输入 Agent 的系统 Prompt" /><div><span>{form.systemPrompt.length.toLocaleString()} / 20,000</span><button type="button" onClick={() => setForm((current) => ({ ...current, systemPrompt: defaultPrompt }))}>恢复默认</button></div></div></SettingRow></>}</section></main>;
}

function SettingRow({ title, description, children }) { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>; }
function Toggle({ checked }) { return <button className={`toggle ${checked ? 'checked' : ''}`} aria-label="切换状态"><i /></button>; }

function ActionModal({ type, onClose, onRun }) {
  const config = actionForms[type];
  const [value, setValue] = useState(type === 'volume' ? '50' : '');
  if (!config) return null;
  const submit = (event) => { event.preventDefault(); if (String(value).trim()) onRun({ type, [config.field]: config.inputType === 'number' ? Number(value) : value }); };
  return <Modal title={config.title} subtitle="操作将由本机 Agent 立即执行" onClose={onClose}><form className="modal-form" onSubmit={submit}><label>{config.label}</label>{config.multiline ? <textarea autoFocus rows={5} value={value} onChange={(e) => setValue(e.target.value)} placeholder={config.placeholder} /> : <input autoFocus className={config.mono ? 'mono-input' : ''} type={config.inputType || 'text'} min="0" max="100" value={value} onChange={(e) => setValue(e.target.value)} placeholder={config.placeholder} />}{type === 'shell' && <div className="field-note"><Terminal size={14} />命令在当前用户主目录执行，最长运行 20 秒。</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Play size={15} />立即执行</button></div></form></Modal>;
}

function SettingsModal({ status, onClose, onSaved, setToast }) {
  const [form, setForm] = useState({ llmBaseUrl: '', llmApiKey: '', llmModel: 'gpt-4o-mini', qqAppId: '', qqAppSecret: '', qqAllowedOpenids: '' });
  const [loading, setLoading] = useState(true);
  const [testingModel, setTestingModel] = useState(false);
  const [testingQQ, setTestingQQ] = useState(false);
  useEffect(() => { api('/api/settings').then(setForm).finally(() => setLoading(false)); }, []);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const persist = () => api('/api/settings', { method: 'PUT', body: JSON.stringify(form) });
  const save = async (event) => { event.preventDefault(); await persist(); setToast({ type: 'success', text: 'Agent 配置已保存' }); onSaved(); onClose(); };
  const testModel = async () => { setTestingModel(true); try { await persist(); const result = await api('/api/llm/test', { method: 'POST' }); setToast({ type: 'success', text: `模型服务连接成功：${result.reply.slice(0, 40)}` }); } catch (error) { setToast({ type: 'error', text: error.message }); } finally { setTestingModel(false); } };
  const testQQ = async () => { setTestingQQ(true); try { await persist(); const result = await api('/api/qq/test', { method: 'POST' }); setToast({ type: result.connected ? 'success' : 'error', text: result.connected ? 'QQ 官方 Gateway 已连接' : (result.error || 'QQ 凭证验证失败') }); onSaved(); } finally { setTestingQQ(false); } };
  return <Modal title="Agent 连接设置" subtitle="配置模型服务与 QQ 开放平台机器人" onClose={onClose} wide>{loading ? <div className="modal-loading"><LoaderCircle className="spin" />读取配置…</div> : <form className="modal-form settings-form" onSubmit={save}><div className="settings-section-heading"><Sparkles size={15} /><div><strong>模型服务</strong><span>支持 OpenAI Chat Completions 兼容接口</span></div></div><div className="form-grid"><div className="field full"><label>服务地址</label><input value={form.llmBaseUrl} onChange={update('llmBaseUrl')} placeholder="https://api.openai.com/v1" /></div><div className="field full"><label>API Key</label><input type="password" value={form.llmApiKey} onChange={update('llmApiKey')} placeholder="sk-..." /></div><div className="field full"><label>模型名称</label><input value={form.llmModel} onChange={update('llmModel')} placeholder="gpt-4o-mini" /></div></div><div className="section-actions"><button type="button" className="secondary-button" onClick={testModel} disabled={testingModel}>{testingModel ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}测试模型服务</button></div><div className="settings-divider" /><div className="settings-section-heading"><MessageCircle size={15} /><div><strong>QQ 官方机器人</strong><span>连接 q.qq.com 创建的机器人</span></div></div><div className={`connection-banner ${status?.qqConnected ? 'connected' : ''}`}><div>{status?.qqConnected ? <CircleCheck size={19} /> : <CircleAlert size={19} />}</div><span><strong>{status?.qqConnected ? 'QQ 官方 Gateway 已连接' : '等待填写开发凭证'}</strong><small>使用 WebSocket 长连接接收消息。</small></span></div><div className="form-grid"><div className="field full"><label>AppID</label><input value={form.qqAppId} onChange={update('qqAppId')} /></div><div className="field full"><label>AppSecret</label><input type="password" value={form.qqAppSecret} onChange={update('qqAppSecret')} /></div><div className="field full"><label>允许控制的用户 OpenID</label><input value={form.qqAllowedOpenids} onChange={update('qqAllowedOpenids')} placeholder="USER_OPENID_1,USER_OPENID_2" /></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={testQQ} disabled={testingQQ}>{testingQQ ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}验证 QQ 连接</button><button className="primary-button" type="submit"><Check size={15} />保存全部配置</button></div></form>}</Modal>;
}

function ScreenshotModal({ src, onClose }) { return <div className="modal-backdrop screenshot-backdrop" onMouseDown={onClose}><div className="screenshot-view" onMouseDown={(e) => e.stopPropagation()}><div className="screenshot-bar"><span><ScreenShare size={16} />当前桌面</span><button className="icon-button" onClick={onClose}><X size={17} /></button></div><img src={src} alt="当前桌面截图" /></div></div>; }
function Modal({ title, subtitle, onClose, children, wide = false }) { useEffect(() => { const close = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]); return <div className="modal-backdrop" onMouseDown={onClose}><div className={`modal ${wide ? 'modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}><div className="modal-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>{children}</div></div>; }

export default App;
