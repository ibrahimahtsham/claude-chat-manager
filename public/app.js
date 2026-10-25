const state = {
  projects: [],
  currentProjectId: null,
  sessions: [],
  currentSession: null,
  activeTab: 'projects',
  lastTab: 'projects',
  view: 'empty',
  memory: [], // one report per project that has a memory folder
  memoryProjectId: null,
  memSelection: null, // 'health' | file name
  memFile: null, // { file, content, mtimeMs, isNew }
  filenameTouched: false,
};

const el = (id) => document.getElementById(id);

const INDEX_FILE = 'MEMORY.md';
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const LEVEL_GLYPH = { error: '✗', warn: '!', info: '·' };
const RESULT_PREVIEW_LINES = 3;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function shortCwd(cwd) {
  if (!cwd) return '';
  return cwd.length > 46 ? '…' + cwd.slice(-45) : cwd;
}

// ---------- status bar ----------

let statusTimer = null;
function status(msg, level = 'ok') {
  const s = el('status-msg');
  s.textContent = `${level === 'ok' ? '✓' : LEVEL_GLYPH[level] || ''} ${msg}`;
  s.className = `status-${level}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(clearStatus, level === 'ok' ? 3000 : 7000);
}

function clearStatus() {
  clearTimeout(statusTimer);
  el('status-msg').textContent = '';
}

// Titles and previews can start with wrapper tags from slash commands.
function cleanText(s) {
  return String(s || '')
    .replace(/<local-command-caveat>[\s\S]*?(<\/local-command-caveat>|$)/g, '')
    .replace(/<\/?[a-z][\w-]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Two-step buttons instead of confirm() dialogs: the first click arms the
// button (turns red with a question), a second click within 3s runs it.
function armable(btn, question, action) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!btn.classList.contains('armed')) {
      btn.dataset.label = btn.innerHTML;
      btn.classList.add('armed');
      btn.textContent = question;
      btn._timer = setTimeout(() => disarm(btn), 3000);
      return;
    }
    disarm(btn);
    try {
      await action();
    } catch (err) {
      status(err.message, 'error');
    }
  });
}

function disarm(btn) {
  clearTimeout(btn._timer);
  if (!btn.classList.contains('armed')) return;
  btn.classList.remove('armed');
  btn.innerHTML = btn.dataset.label;
}

// ---------- API ----------

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const getProjects = () => api('/api/projects');
const getSessions = (projectId) => api(`/api/sessions?project=${encodeURIComponent(projectId)}`);
const getSession = (projectId, sessionId) =>
  api(`/api/session?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`);
const deleteSessionApi = (projectId, sessionId) =>
  api(`/api/session?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
const renameSessionApi = (projectId, sessionId, title) =>
  post('/api/session/rename', { project: projectId, session: sessionId, title });
const searchApi = (q) => api(`/api/search?q=${encodeURIComponent(q)}`);
const getTrash = () => api('/api/trash');
const restoreApi = (projectId, sessionId) => post('/api/trash/restore', { project: projectId, session: sessionId });
const purgeApi = (projectId, sessionId) => post('/api/trash/purge', { project: projectId, session: sessionId });

const getMemory = () => api('/api/memory');
const getMemoryFile = (projectId, file) =>
  api(`/api/memory/file?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(file)}`);
const getMemoryTrash = () => api('/api/memory/trash');

// ---------- views ----------

function showView(name) {
  state.view = name;
  const ids = { empty: 'empty-state', session: 'session-view', memory: 'memory-view', health: 'health-view' };
  for (const [key, id] of Object.entries(ids)) el(id).hidden = key !== name;
}

function switchTab(tab) {
  if (tab !== 'search') state.lastTab = tab;
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  el(`panel-${tab}`).classList.add('active');
}

// Leaving the memory editor with unsaved edits needs a second click.
let discardArmedUntil = 0;
function editorDirty() {
  return state.view === 'memory' && state.memFile && el('memory-editor').value !== state.memFile.content;
}

function canLeaveEditor() {
  if (!editorDirty()) return true;
  if (Date.now() < discardArmedUntil) {
    discardArmedUntil = 0;
    clearStatus();
    return true;
  }
  discardArmedUntil = Date.now() + 4000;
  status(`unsaved changes in ${state.memFile.isNew ? 'the new memory' : state.memFile.file}; click again to discard them`, 'warn');
  return false;
}

// ---------- rendering: chats sidebar ----------

function renderProjectSelect() {
  const sel = el('project-select');
  sel.innerHTML = '';
  if (state.projects.length === 0) {
    sel.innerHTML = '<option>no projects found</option>';
    return;
  }
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${shortCwd(p.cwd)} (${p.sessionCount})`;
    sel.appendChild(opt);
  }
  sel.value = state.currentProjectId;
}

function renderSessionList() {
  const list = el('session-list');
  list.innerHTML = '';
  if (state.sessions.length === 0) {
    list.innerHTML = '<div class="empty-list-msg">no chats in this project.</div>';
    return;
  }
  for (const s of state.sessions) {
    const item = document.createElement('div');
    const selected = state.view === 'session' && state.currentSession && state.currentSession.id === s.id;
    item.className = 'item' + (selected ? ' selected' : '');
    item.innerHTML = `
      <div class="item-title">${escapeHtml(cleanText(s.title) || '(slash command)')}</div>
      <div class="item-meta"><span>${s.messageCount} msgs</span><span>${fmtDate(s.updatedAt)}</span></div>
      <div class="item-preview">${escapeHtml(cleanText(s.preview))}</div>
    `;
    item.addEventListener('click', () => openSession(state.currentProjectId, s.id));
    list.appendChild(item);
  }
}

function renderSearchResults(results, query) {
  const list = el('search-list');
  list.innerHTML = '';
  if (results.length === 0) {
    list.innerHTML = `<div class="empty-list-msg">no matches for "${escapeHtml(query)}".</div>`;
    return;
  }
  const re = new RegExp(`(${escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  list.insertAdjacentHTML('beforeend', `<div class="group">${results.length} result${results.length === 1 ? '' : 's'}</div>`);
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'item';
    const snippetHtml = escapeHtml(r.snippet).replace(re, '<mark>$1</mark>');
    item.innerHTML = `
      <div class="item-title">${escapeHtml(cleanText(r.title) || '(slash command)')}</div>
      <div class="item-meta"><span>${escapeHtml(shortCwd(r.projectCwd))}</span><span>${fmtDate(r.updatedAt)}</span></div>
      <div class="item-preview">…${snippetHtml}…</div>
    `;
    item.addEventListener('click', () => openSession(r.projectId, r.sessionId));
    list.appendChild(item);
  }
}

// ---------- rendering: transcript ----------

function renderInline(s) {
  let h = escapeHtml(s);
  const codes = [];
  h = h.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  h = h
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

// Small markdown subset: headings, lists, quotes, fenced code, inline
// code/bold/italic/links. Everything is escaped first.
function renderMarkdown(src) {
  let out = '';
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) {
        out += `<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`;
        code = null;
      } else {
        closeList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      closeList();
      out += `<div class="md-h">${renderInline(m[1])}</div>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') {
        closeList();
        out += '<ul>';
        list = 'ul';
      }
      out += `<li>${renderInline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') {
        closeList();
        out += '<ol>';
        list = 'ol';
      }
      out += `<li>${renderInline(m[1])}</li>`;
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      out += `<div class="md-quote">${renderInline(m[1])}</div>`;
    } else if (!line.trim()) {
      closeList();
      out += '<div class="md-gap"></div>';
    } else {
      closeList();
      out += `<div>${renderInline(line)}</div>`;
    }
  }
  if (code) out += `<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`;
  closeList();
  return out;
}

const TOOL_ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'skill', 'description', 'prompt'];

function toolLabel(name, input) {
  // mcp__server__tool -> tool (server)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name || '');
  const display = mcp ? `${mcp[2]} (${mcp[1]})` : name || 'tool';
  let arg = '';
  if (input && typeof input === 'object') {
    const key = TOOL_ARG_KEYS.find((k) => typeof input[k] === 'string');
    if (key) arg = input[key].split('\n')[0];
  }
  return { display, arg };
}

function resultHtml(content, isError) {
  const text = String(content || '').replace(/\s+$/, '') || '(no output)';
  const lines = text.split('\n');
  const cls = `ln-result${isError ? ' is-error' : ''}`;
  const clip = (l) => (l.length > 300 ? l.slice(0, 300) + '…' : l);
  if (lines.length <= RESULT_PREVIEW_LINES && text.length <= 900) {
    return `<div class="${cls}"><span class="g">⎿</span><pre>${escapeHtml(text)}</pre></div>`;
  }
  const preview = lines.slice(0, RESULT_PREVIEW_LINES).map(clip).join('\n');
  const more = lines.length > RESULT_PREVIEW_LINES ? `+${lines.length - RESULT_PREVIEW_LINES} lines` : 'more';
  return `<details class="${cls}">
    <summary><span class="g">⎿</span><pre class="when-closed">${escapeHtml(preview)}\n<span class="more">… ${more} (click to expand)</span></pre><pre class="when-open more">click to collapse</pre></summary>
    <pre class="full">${escapeHtml(text)}</pre>
  </details>`;
}

function promptLine(glyph, text, ts) {
  return `<div class="ln ln-user" title="${escapeHtml(fmtDate(ts))}"><span class="g">${glyph}</span><div class="ln-body">${escapeHtml(text)}</div></div>`;
}

// User turns carry wrapper tags for shell commands, slash commands and
// system reminders; show those the way the terminal does.
function userTextHtml(text, ts) {
  const take = (tag) => {
    const found = [];
    text = text.replace(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'), (_, v) => {
      found.push(v);
      return '';
    });
    return found;
  };
  const reminders = take('system-reminder');
  const bashIn = take('bash-input');
  const bashOut = [...take('bash-stdout'), ...take('local-command-stdout')];
  const bashErr = take('bash-stderr');
  const cmdName = take('command-name');
  const cmdArgs = take('command-args');
  take('command-message');

  const out = [];
  if (cmdName.length) out.push(promptLine('&gt;', `${cmdName[0]} ${cmdArgs[0] || ''}`.trim(), ts));
  for (const c of bashIn) out.push(promptLine('<span class="c-pink">!</span>', c, ts));
  for (const o of bashOut) if (o.trim()) out.push(resultHtml(o, false));
  for (const o of bashErr) if (o.trim()) out.push(resultHtml(o, true));
  const rest = text.trim();
  if (rest) out.push(promptLine('&gt;', rest, ts));
  if (reminders.length) {
    out.push(`<details class="ln-note"><summary><span class="g">⎿</span> system reminder${reminders.length > 1 ? 's' : ''}</summary><pre>${escapeHtml(reminders.join('\n\n').trim())}</pre></details>`);
  }
  return out.join('');
}

function blockHtml(block, msg) {
  const isUser = msg.role === 'user';
  if (block.type === 'text') {
    if (isUser) return userTextHtml(block.text, msg.timestamp);
    return `<div class="ln ln-ai"><span class="g">●</span><div class="ln-body md">${renderMarkdown(block.text)}</div></div>`;
  }
  if (block.type === 'thinking') {
    return `<details class="ln-think"><summary><span class="g">✻</span> thinking…</summary><pre>${escapeHtml(block.text)}</pre></details>`;
  }
  if (block.type === 'tool_use') {
    const { display, arg } = toolLabel(block.name, block.input);
    let input;
    try {
      input = JSON.stringify(block.input, null, 2);
    } catch {
      input = String(block.input);
    }
    return `<details class="ln-tool">
      <summary><span class="g">●</span><span class="tool-name">${escapeHtml(display)}</span><span class="tool-arg">${arg ? `(${escapeHtml(arg)})` : ''}</span></summary>
      <pre>${escapeHtml(input)}</pre>
    </details>`;
  }
  if (block.type === 'tool_result') return resultHtml(block.content, block.isError);
  if (block.type === 'image_ref') return '<div class="ln ln-image"><span class="g">⎿</span>[image]</div>';
  return '';
}

function renderMessages(session) {
  const container = el('messages');
  const parts = [];
  for (const m of session.messages) for (const b of m.blocks) parts.push(blockHtml(b, m));
  container.innerHTML = parts.join('') || '<div class="empty-list-msg">this chat has no messages.</div>';
  container.scrollTop = 0;
}

function renderSessionHeader(session) {
  el('session-title').textContent = session.title;
  el('session-cwd').textContent = session.cwd || '';
  el('session-dates').textContent = session.messages.length ? `${session.messages.length} messages` : '';
}

// ---------- rendering: memory ----------

function currentReport() {
  return state.memory.find((r) => r.projectId === state.memoryProjectId) || null;
}

function issueCounts(issues) {
  const c = { error: 0, warn: 0, info: 0 };
  for (const i of issues) c[i.level]++;
  return c;
}

function issueSummary(issues) {
  const c = issueCounts(issues);
  const parts = [];
  if (c.error) parts.push(`<span class="c-red">${c.error} error${c.error > 1 ? 's' : ''}</span>`);
  if (c.warn) parts.push(`<span class="c-yellow">${c.warn} warning${c.warn > 1 ? 's' : ''}</span>`);
  if (c.info) parts.push(`<span class="dim">${c.info} note${c.info > 1 ? 's' : ''}</span>`);
  return parts.length ? parts.join(' · ') : '<span class="c-green">✓ all good</span>';
}

function issuesForFile(report, file) {
  return report.issues.filter((i) => i.file === file || i.other === file);
}

function worstLevel(issues) {
  if (issues.some((i) => i.level === 'error')) return 'error';
  if (issues.some((i) => i.level === 'warn')) return 'warn';
  return null;
}

function renderMemoryBadge() {
  const all = state.memory.flatMap((r) => r.issues);
  const c = issueCounts(all);
  const badge = el('memory-badge');
  badge.hidden = !(c.error + c.warn);
  badge.textContent = c.error ? `✗${c.error + c.warn}` : `!${c.warn}`;
  badge.classList.toggle('has-error', c.error > 0);
}

function renderMemoryProjectSelect() {
  const sel = el('memory-project-select');
  sel.innerHTML = '';
  sel.hidden = state.memory.length === 0;
  for (const r of state.memory) {
    const opt = document.createElement('option');
    opt.value = r.projectId;
    opt.textContent = `${shortCwd(r.cwd)} (${r.memories.length})`;
    sel.appendChild(opt);
  }
  sel.value = state.memoryProjectId;
}

function memItem({ key, title, meta, preview, level }) {
  const selected = (state.view === 'memory' || state.view === 'health') && state.memSelection === key;
  const flag = level ? `<span class="${level === 'error' ? 'c-red' : 'c-yellow'}">${LEVEL_GLYPH[level]}</span> ` : '';
  return `<div class="item${selected ? ' selected' : ''}" data-key="${escapeHtml(key)}">
    <div class="item-title">${flag}${escapeHtml(title)}</div>
    <div class="item-meta"><span>${meta}</span></div>
    ${preview ? `<div class="item-preview">${escapeHtml(preview)}</div>` : ''}
  </div>`;
}

function renderMemorySidebar() {
  const list = el('memory-list');
  const r = currentReport();
  if (!r) {
    list.innerHTML = '<div class="empty-list-msg">no memory folders yet. Claude makes one the first time it saves a memory in a project.</div>';
    return;
  }
  let html = memItem({ key: 'health', title: 'health check', meta: issueSummary(r.issues) });
  html += memItem({
    key: INDEX_FILE,
    title: INDEX_FILE,
    meta: `index · ${r.index.lines} lines · loaded every session`,
    level: worstLevel(issuesForFile(r, INDEX_FILE).concat(r.issues.filter((i) => i.kind === 'missing-file'))),
  });

  const known = new Set(MEMORY_TYPES);
  const groups = [...MEMORY_TYPES, 'other'].map((type) => ({
    type,
    items: r.memories.filter((m) => (type === 'other' ? !known.has(m.type) : m.type === type)),
  }));
  for (const g of groups) {
    if (!g.items.length) continue;
    html += `<div class="group"><span class="t-${g.type}">${g.type}</span> ${g.items.length}</div>`;
    for (const m of g.items) {
      html += memItem({
        key: m.file,
        title: m.name || m.file,
        meta: escapeHtml(m.file),
        preview: m.description,
        level: worstLevel(issuesForFile(r, m.file)),
      });
    }
  }
  html += '<button class="btn primary new-mem" id="new-mem-btn">+ new memory</button>';
  list.innerHTML = html;
  list.querySelectorAll('.item').forEach((item) => {
    item.addEventListener('click', () => {
      const key = item.dataset.key;
      if (key === 'health') showHealth();
      else openMemoryFile(key);
    });
  });
  el('new-mem-btn').addEventListener('click', newMemory);
}

function fixButtons(issue) {
  const b = (fix, label, file, extra = '') =>
    `<button class="btn ${extra}" data-fix="${fix}" data-file="${escapeHtml(file)}">${label}</button>`;
  switch (issue.kind) {
    case 'missing-file':
      return b('index-remove', 'remove line from index', issue.file) + b('open', 'open MEMORY.md', INDEX_FILE);
    case 'not-indexed':
      return b('index-add', 'add to index', issue.file, 'primary') + b('open', 'open', issue.file);
    case 'duplicate':
      return b('open', `open ${issue.file}`, issue.file) + b('open', `open ${issue.other}`, issue.other);
    case 'duplicate-index':
    case 'index-too-long':
      return b('open', 'open MEMORY.md', INDEX_FILE);
    default:
      return b('open', 'open', issue.file);
  }
}

function issueHtml(issue, withFixes) {
  return `<div class="issue lvl-${issue.level}">
    <span class="g">${LEVEL_GLYPH[issue.level]}</span>
    <div class="issue-body">
      <div>${escapeHtml(issue.message)}</div>
      ${withFixes ? `<div class="issue-actions">${fixButtons(issue)}</div>` : ''}
    </div>
  </div>`;
}

function renderHealth() {
  const r = currentReport();
  if (!r) return;
  el('health-meta').innerHTML = `<span>${escapeHtml(r.cwd)}</span><span>${r.memories.length} memories</span><span>index ${r.index.lines} lines</span><span>${issueSummary(r.issues)}</span>`;
  let html = '';
  if (!r.issues.length) {
    html += '<div class="all-good"><span class="c-green">✓</span> all good: every memory is in the index, frontmatter is complete, and nothing looks duplicated.</div>';
  }
  const sections = [
    ['error', 'errors'],
    ['warn', 'warnings'],
    ['info', 'notes'],
  ];
  for (const [level, label] of sections) {
    const items = r.issues.filter((i) => i.level === level);
    if (!items.length) continue;
    html += `<div class="health-section">${label}</div>`;
    html += items.map((i) => issueHtml(i, true)).join('');
  }
  html += `<div class="health-help">
    <div><b>how Claude's memory works</b></div>
    <div><span class="c-claude">MEMORY.md</span> is the index. It's loaded at the start of every session in this project, one line per memory.</div>
    <div>Each other file holds one fact. Claude only opens a file when its index line looks relevant, so a file missing from the index is effectively invisible.</div>
    <div>Types: <span class="t-user">user</span> (who you are) · <span class="t-feedback">feedback</span> (how you want Claude to work) · <span class="t-project">project</span> (ongoing goals) · <span class="t-reference">reference</span> (links, dashboards).</div>
  </div>`;
  el('health-list').innerHTML = html;
}

function renderMemoryHeader() {
  const f = state.memFile;
  const r = currentReport();
  const isIndex = f.file === INDEX_FILE;
  const m = !f.isNew && r ? r.memories.find((x) => x.file === f.file) : null;

  el('memory-title').textContent = f.isNew ? 'new memory' : isIndex ? INDEX_FILE : (m && m.name) || f.file;
  const type = el('memory-type');
  type.textContent = m && m.type ? m.type : isIndex ? 'index' : '';
  type.className = `tag t-${m && m.type ? m.type : 'other'}`;

  let meta = '';
  if (f.isNew) {
    meta = '<span>not saved yet · it is added to MEMORY.md when you save</span>';
  } else if (isIndex) {
    meta = `<span>loaded into every session</span><span>${r ? r.index.lines : 0} lines</span>`;
    if (f.mtimeMs) meta += `<span>modified ${fmtDate(f.mtimeMs)}</span>`;
  } else if (m) {
    meta = `<span>${escapeHtml(m.file)}</span><span>${fmtBytes(m.size)}</span><span>modified ${fmtDate(m.mtimeMs)}</span>`;
    meta += m.indexed ? '<span class="c-green">✓ in index</span>' : '<span class="c-yellow">! not in index</span>';
    if (m.links.length) {
      const byName = new Map(r.memories.map((x) => [x.name, x.file]));
      const links = m.links
        .map((l) => {
          const target = byName.get(l) || r.memories.find((x) => x.file === l || x.file === `${l}.md`)?.file;
          return target
            ? `<button class="link-btn" data-open="${escapeHtml(target)}">[[${escapeHtml(l)}]]</button>`
            : `<span class="missing" title="no memory with this name yet">[[${escapeHtml(l)}]]</span>`;
        })
        .join('');
      meta += `<span class="mem-links">links ${links}</span>`;
    }
  }
  el('memory-meta').innerHTML = meta;
  el('memory-meta').querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => openMemoryFile(b.dataset.open))
  );

  el('memory-filename-row').hidden = !f.isNew;
  el('memory-delete-btn').hidden = f.isNew || isIndex;
  el('memory-revert-btn').hidden = f.isNew;

  const issues = r && !f.isNew ? issuesForFile(r, f.file) : [];
  el('memory-file-issues').innerHTML = issues.map((i) => issueHtml(i, false)).join('');
  updateDirty();
}

function updateDirty() {
  el('memory-dirty').hidden = !editorDirty();
}

function renderTrash(chats, memories) {
  const list = el('trash-list');
  list.innerHTML = '';
  if (!chats.length && !memories.length) {
    list.innerHTML = '<div class="empty-list-msg">trash is empty.</div>';
    return;
  }
  const addItem = ({ title, meta, onRestore, onPurge }) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="item-title">${escapeHtml(title)}</div>
      <div class="item-meta"><span>${meta}</span></div>
      <div class="item-actions">
        <button class="btn restore-btn">restore</button>
        <button class="btn danger purge-btn">delete forever</button>
      </div>
    `;
    item.querySelector('.restore-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await onRestore();
      } catch (err) {
        status(err.message, 'error');
      }
    });
    armable(item.querySelector('.purge-btn'), 'really delete?', onPurge);
    list.appendChild(item);
  };

  if (chats.length) list.insertAdjacentHTML('beforeend', `<div class="group">chats ${chats.length}</div>`);
  for (const s of chats) {
    addItem({
      title: s.title,
      meta: `${escapeHtml(shortCwd(s.cwd))} · ${fmtDate(s.updatedAt)}`,
      onRestore: async () => {
        await restoreApi(s.projectId, s.id);
        status(`restored "${s.title}"`);
        await refreshTrash();
        await loadProjects();
      },
      onPurge: async () => {
        await purgeApi(s.projectId, s.id);
        status('chat deleted forever');
        await refreshTrash();
      },
    });
  }

  if (memories.length) list.insertAdjacentHTML('beforeend', `<div class="group">memory ${memories.length}</div>`);
  for (const m of memories) {
    addItem({
      title: m.file,
      meta: `${escapeHtml(m.description || 'memory')} · deleted ${fmtDate(m.deletedAt)}`,
      onRestore: async () => {
        await post('/api/memory/restore', { project: m.projectId, id: m.id });
        status(`restored ${m.file} and its index line`);
        await refreshTrash();
        await reloadMemory();
      },
      onPurge: async () => {
        await post('/api/memory/purge', { project: m.projectId, id: m.id });
        status(`${m.file} deleted forever`);
        await refreshTrash();
      },
    });
  }
}

// ---------- actions: chats ----------

async function loadProjects() {
  state.projects = await getProjects();
  if (!state.currentProjectId && state.projects.length) {
    state.currentProjectId = state.projects[0].id;
  }
  renderProjectSelect();
  if (state.currentProjectId) {
    await loadSessions(state.currentProjectId);
  }
}

async function loadSessions(projectId) {
  state.currentProjectId = projectId;
  state.sessions = await getSessions(projectId);
  renderSessionList();
}

async function openSession(projectId, sessionId) {
  if (!canLeaveEditor()) return;
  switchTab('projects');
  if (state.currentProjectId !== projectId) {
    state.currentProjectId = projectId;
    el('project-select').value = projectId;
    await loadSessions(projectId);
  }
  const session = await getSession(projectId, sessionId);
  state.currentSession = session;
  showView('session');
  cancelRename();
  renderSessionHeader(session);
  renderMessages(session);
  renderSessionList();
}

async function refreshTrash() {
  const [chats, memories] = await Promise.all([getTrash(), getMemoryTrash()]);
  renderTrash(chats, memories);
}

function sessionToMarkdown(session) {
  let out = `# ${session.title}\n\n`;
  if (session.cwd) out += `_Project: ${session.cwd}_\n\n`;
  for (const m of session.messages) {
    out += `### ${m.role === 'user' ? 'You' : 'Claude'}\n\n`;
    for (const b of m.blocks) {
      if (b.type === 'text') out += `${b.text}\n\n`;
      else if (b.type === 'tool_use') out += `> tool: ${b.name}\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\`\n\n`;
      else if (b.type === 'tool_result') out += `> result:\n\`\`\`\n${b.content}\n\`\`\`\n\n`;
    }
  }
  return out;
}

function startRename() {
  if (!state.currentSession) return;
  const input = el('rename-input');
  input.value = state.currentSession.title;
  el('session-title').hidden = true;
  el('rename-btn').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function cancelRename() {
  el('rename-input').hidden = true;
  el('session-title').hidden = false;
  el('rename-btn').hidden = false;
}

async function commitRename() {
  const next = el('rename-input').value;
  cancelRename();
  const { projectId, id } = state.currentSession;
  await renameSessionApi(projectId, id, next);
  const session = await getSession(projectId, id);
  state.currentSession = session;
  renderSessionHeader(session);
  await loadSessions(state.currentProjectId);
  status(next.trim() ? `renamed to "${session.title}"` : 'name reset to the automatic title');
}

// ---------- actions: memory ----------

async function reloadMemory() {
  state.memory = (await getMemory()).projects;
  if (!currentReport()) {
    const withFiles = state.memory.find((r) => r.memories.length) || state.memory[0];
    state.memoryProjectId = withFiles ? withFiles.projectId : null;
  }
  renderMemoryBadge();
  renderMemoryProjectSelect();
  renderMemorySidebar();
  if (state.view === 'health') renderHealth();
  if (state.view === 'memory' && state.memFile) renderMemoryHeader();
}

function showHealth() {
  if (!canLeaveEditor()) return;
  if (!currentReport()) return;
  state.memSelection = 'health';
  state.memFile = null;
  showView('health');
  renderHealth();
  renderMemorySidebar();
}

async function openMemoryFile(file, { force = false } = {}) {
  if (!force && !canLeaveEditor()) return;
  const data = await getMemoryFile(state.memoryProjectId, file);
  state.memFile = { file, content: data.content, mtimeMs: data.mtimeMs, isNew: false };
  state.memSelection = file;
  if (state.activeTab !== 'memory') switchTab('memory');
  showView('memory');
  el('memory-editor').value = data.content;
  renderMemoryHeader();
  renderMemorySidebar();
}

function newMemory() {
  if (!canLeaveEditor()) return;
  const template = '---\nname: \ndescription: \nmetadata:\n  type: feedback\n---\n\n';
  state.memFile = { file: '', content: template, mtimeMs: null, isNew: true };
  state.memSelection = null;
  state.filenameTouched = false;
  el('memory-filename').value = '';
  showView('memory');
  const editor = el('memory-editor');
  editor.value = template;
  renderMemoryHeader();
  renderMemorySidebar();
  editor.focus();
  editor.setSelectionRange(10, 10); // after "name: "
}

function slugFromEditor() {
  const m = el('memory-editor').value.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') : '';
}

async function saveMemory() {
  const f = state.memFile;
  if (!f || state.view !== 'memory') return;
  const content = el('memory-editor').value;
  let file = f.file;
  if (f.isNew) {
    file = el('memory-filename').value.trim() || slugFromEditor();
    if (!file) {
      status('give the memory a name (or a file name) first', 'warn');
      return;
    }
    if (!file.endsWith('.md')) file += '.md';
  }
  try {
    const res = await post('/api/memory/save', {
      project: state.memoryProjectId,
      file,
      content,
      expectedMtime: f.isNew ? null : f.mtimeMs,
      create: f.isNew,
    });
    state.memFile = { file, content, mtimeMs: res.mtimeMs, isNew: false };
    state.memSelection = file;
    await reloadMemory();
    status(res.indexed ? `saved ${file} and added it to MEMORY.md` : `saved ${file}`);
  } catch (err) {
    status(err.message, 'error');
  }
}

async function applyFix(fix, file) {
  const project = state.memoryProjectId;
  if (fix === 'open') return openMemoryFile(file);
  if (fix === 'index-add') {
    await post('/api/memory/index/add', { project, file });
    status(`added ${file} to MEMORY.md`);
  } else if (fix === 'index-remove') {
    const res = await post('/api/memory/index/remove', { project, file });
    status(`removed ${res.removed} line${res.removed === 1 ? '' : 's'} for ${file} from MEMORY.md`);
  }
  await reloadMemory();
}

// ---------- wiring ----------

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', async () => {
    const tab = t.dataset.tab;
    el('search-input').value = '';
    switchTab(tab);
    if (tab === 'trash') await refreshTrash();
    if (tab === 'memory') {
      await reloadMemory();
      if (state.view !== 'memory' && state.view !== 'health') showHealth();
    }
  });
});

el('project-select').addEventListener('change', (e) => loadSessions(e.target.value));

el('memory-project-select').addEventListener('change', (e) => {
  if (!canLeaveEditor()) {
    e.target.value = state.memoryProjectId;
    return;
  }
  state.memFile = null;
  state.memoryProjectId = e.target.value;
  renderMemorySidebar();
  showHealth();
});

let searchTimer = null;
el('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    switchTab(state.lastTab);
    return;
  }
  searchTimer = setTimeout(async () => {
    switchTab('search');
    el('search-list').innerHTML = '<div class="empty-list-msg">searching…</div>';
    try {
      renderSearchResults(await searchApi(q), q);
    } catch (err) {
      status(err.message, 'error');
    }
  }, 250);
});

el('search-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.target.value = '';
  e.target.blur();
  switchTab(state.lastTab);
});

el('rename-btn').addEventListener('click', startRename);
el('rename-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commitRename().catch((err) => status(err.message, 'error'));
  if (e.key === 'Escape') cancelRename();
});
el('rename-input').addEventListener('blur', () => {
  if (!el('rename-input').hidden) cancelRename();
});

armable(el('delete-btn'), 'move to trash?', async () => {
  if (!state.currentSession) return;
  const title = state.currentSession.title;
  await deleteSessionApi(state.currentSession.projectId, state.currentSession.id);
  state.currentSession = null;
  showView('empty');
  await loadSessions(state.currentProjectId);
  status(`moved "${title}" to trash`);
});

el('copy-md-btn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  try {
    await navigator.clipboard.writeText(sessionToMarkdown(state.currentSession));
    status('copied chat as markdown');
  } catch {
    status('could not copy to the clipboard', 'error');
  }
});

el('memory-save-btn').addEventListener('click', saveMemory);

el('memory-revert-btn').addEventListener('click', async () => {
  if (!state.memFile || state.memFile.isNew) return;
  try {
    await reloadMemory();
    await openMemoryFile(state.memFile.file, { force: true });
    status(`reloaded ${state.memFile.file} from disk`);
  } catch (err) {
    status(err.message, 'error');
  }
});

armable(el('memory-delete-btn'), 'move to trash?', async () => {
  const file = state.memFile.file;
  const res = await post('/api/memory/delete', { project: state.memoryProjectId, file });
  state.memFile = null;
  await reloadMemory();
  showHealth();
  status(`moved ${file} to trash${res.removedIndexLines ? ' and removed its index line' : ''}`);
});

el('memory-editor').addEventListener('input', () => {
  updateDirty();
  if (state.memFile && state.memFile.isNew && !state.filenameTouched) {
    const slug = slugFromEditor();
    el('memory-filename').value = slug ? `${slug}.md` : '';
  }
});

el('memory-editor').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  document.execCommand('insertText', false, '  ');
});

el('memory-filename').addEventListener('input', () => (state.filenameTouched = true));

el('health-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fix]');
  if (!btn) return;
  try {
    await applyFix(btn.dataset.fix, btn.dataset.file);
  } catch (err) {
    status(err.message, 'error');
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.view === 'memory') {
    e.preventDefault();
    saveMemory();
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    el('search-input').focus();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (editorDirty()) e.preventDefault();
});

Promise.all([loadProjects(), reloadMemory()]).catch((err) => {
  el('empty-state').innerHTML = `<div class="welcome"><span class="c-red">✗</span> failed to load: ${escapeHtml(err.message)}</div>`;
});
