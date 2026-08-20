const state = {
  projects: [],
  currentProjectId: null,
  sessions: [],
  currentSession: null,
  activeTab: 'projects',
};

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function shortCwd(cwd) {
  if (!cwd) return '';
  return cwd.length > 46 ? '…' + cwd.slice(-45) : cwd;
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

const getProjects = () => api('/api/projects');
const getSessions = (projectId) => api(`/api/sessions?project=${encodeURIComponent(projectId)}`);
const getSession = (projectId, sessionId) =>
  api(`/api/session?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`);
const deleteSessionApi = (projectId, sessionId) =>
  api(`/api/session?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
const renameSessionApi = (projectId, sessionId, title) =>
  api('/api/session/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectId, session: sessionId, title }),
  });
const searchApi = (q) => api(`/api/search?q=${encodeURIComponent(q)}`);
const getTrash = () => api('/api/trash');
const restoreApi = (projectId, sessionId) =>
  api('/api/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectId, session: sessionId }),
  });
const purgeApi = (projectId, sessionId) =>
  api('/api/trash/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectId, session: sessionId }),
  });

// ---------- rendering: sidebar ----------

function renderProjectSelect() {
  const sel = el('project-select');
  sel.innerHTML = '';
  if (state.projects.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No projects found';
    sel.appendChild(opt);
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
    list.innerHTML = '<div class="empty-list-msg">No chats in this project.</div>';
    return;
  }
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (state.currentSession && state.currentSession.id === s.id ? ' selected' : '');
    item.innerHTML = `
      <div class="title">${escapeHtml(s.title)}</div>
      <div class="meta"><span>${s.messageCount} msgs</span><span>${fmtDate(s.updatedAt)}</span></div>
      <div class="preview">${escapeHtml(s.preview)}</div>
    `;
    item.addEventListener('click', () => openSession(state.currentProjectId, s.id));
    list.appendChild(item);
  }
}

function renderTrashList(items) {
  const list = el('trash-list');
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-list-msg">Trash is empty.</div>';
    return;
  }
  for (const s of items) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="title">${escapeHtml(s.title)}</div>
      <div class="meta"><span>${shortCwd(s.cwd)}</span><span>${fmtDate(s.updatedAt)}</span></div>
      <div class="session-actions" style="margin-top:8px;">
        <button class="btn restore-btn">Restore</button>
        <button class="btn danger purge-btn">Delete forever</button>
      </div>
    `;
    item.querySelector('.restore-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await restoreApi(s.projectId, s.id);
      await refreshTrash();
      await loadProjects();
    });
    item.querySelector('.purge-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Permanently delete this chat? This cannot be undone.')) return;
      await purgeApi(s.projectId, s.id);
      await refreshTrash();
    });
    list.appendChild(item);
  }
}

function renderSearchResults(results, query) {
  const list = el('search-list');
  list.innerHTML = '';
  if (results.length === 0) {
    list.innerHTML = '<div class="empty-list-msg">No matches.</div>';
    return;
  }
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'search-result';
    const snippetHtml = escapeHtml(r.snippet).replace(re, '<mark>$1</mark>');
    item.innerHTML = `
      <div class="title">${escapeHtml(r.title)}</div>
      <div class="path">${escapeHtml(shortCwd(r.projectCwd))} · ${fmtDate(r.updatedAt)}</div>
      <div class="snippet">…${snippetHtml}…</div>
    `;
    item.addEventListener('click', () => openSession(r.projectId, r.sessionId));
    list.appendChild(item);
  }
}

// ---------- rendering: chat view ----------

function blockHtml(block) {
  if (block.type === 'text') {
    return `<div class="block-text">${escapeHtml(block.text)}</div>`;
  }
  if (block.type === 'thinking') {
    return `<details class="block-thinking">
      <summary>internal reasoning</summary>
      <pre>${escapeHtml(block.text)}</pre>
    </details>`;
  }
  if (block.type === 'tool_use') {
    const input = (() => {
      try {
        return JSON.stringify(block.input, null, 2);
      } catch {
        return String(block.input);
      }
    })();
    return `<details class="block-tool">
      <summary>🔧 ${escapeHtml(block.name || 'tool')}</summary>
      <pre>${escapeHtml(input)}</pre>
    </details>`;
  }
  if (block.type === 'tool_result') {
    const cls = block.isError ? 'block-tool-result error' : 'block-tool-result';
    return `<details class="block-tool ${cls}">
      <summary>${block.isError ? '✖ tool error' : '↩ tool result'}</summary>
      <pre>${escapeHtml(block.content || '')}</pre>
    </details>`;
  }
  if (block.type === 'image_ref') {
    return `<div class="block-text" style="color:var(--text-dim);font-style:italic;">[image attachment]</div>`;
  }
  return '';
}

function renderMessages(session) {
  const container = el('messages');
  container.innerHTML = '';
  for (const m of session.messages) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const roleLabel = m.role === 'user' ? 'You' : 'Claude';
    bubble.innerHTML = `<div class="role-label">${roleLabel} · ${fmtDate(m.timestamp)}</div>` +
      m.blocks.map(blockHtml).join('');
    wrap.appendChild(bubble);
    container.appendChild(wrap);
  }
  container.scrollTop = 0;
}

function renderSessionHeader(session) {
  el('session-title').textContent = session.title;
  el('session-cwd').textContent = session.cwd || '';
  const dates = session.messages.length
    ? `${session.messages.length} messages`
    : '';
  el('session-dates').textContent = dates;
}

// ---------- actions ----------

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
  switchTab('projects');
  if (state.currentProjectId !== projectId) {
    state.currentProjectId = projectId;
    el('project-select').value = projectId;
    await loadSessions(projectId);
  }
  const session = await getSession(projectId, sessionId);
  state.currentSession = session;
  el('empty-state').hidden = true;
  el('session-view').hidden = false;
  renderSessionHeader(session);
  renderMessages(session);
  renderSessionList();
}

async function refreshTrash() {
  const items = await getTrash();
  renderTrashList(items);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  el(`panel-${tab}`).classList.add('active');
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

// ---------- wiring ----------

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

el('project-select').addEventListener('change', (e) => {
  loadSessions(e.target.value);
});

let searchTimer = null;
el('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    switchTab('projects');
    return;
  }
  searchTimer = setTimeout(async () => {
    switchTab('search');
    const results = await searchApi(q);
    renderSearchResults(results, q);
  }, 250);
});

el('rename-btn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  const next = prompt('Rename chat:', state.currentSession.title);
  if (next === null) return;
  await renameSessionApi(state.currentSession.projectId, state.currentSession.id, next);
  const session = await getSession(state.currentSession.projectId, state.currentSession.id);
  state.currentSession = session;
  renderSessionHeader(session);
  await loadSessions(state.currentProjectId);
});

el('delete-btn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  if (!confirm(`Move "${state.currentSession.title}" to trash?`)) return;
  await deleteSessionApi(state.currentSession.projectId, state.currentSession.id);
  state.currentSession = null;
  el('session-view').hidden = true;
  el('empty-state').hidden = false;
  await loadSessions(state.currentProjectId);
});

el('copy-md-btn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  const md = sessionToMarkdown(state.currentSession);
  try {
    await navigator.clipboard.writeText(md);
    const btn = el('copy-md-btn');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = original), 1200);
  } catch {
    alert('Could not copy to clipboard.');
  }
});

// tab-specific loaders
document.querySelector('[data-tab="trash"]').addEventListener('click', refreshTrash);

loadProjects().catch((err) => {
  el('empty-state').innerHTML = `<p>Failed to load: ${escapeHtml(err.message)}</p>`;
});
