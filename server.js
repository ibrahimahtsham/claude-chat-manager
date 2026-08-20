const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 5173;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const APP_DATA_DIR = path.join(__dirname, 'data');
const TRASH_DIR = path.join(APP_DATA_DIR, 'trash');
const OVERRIDES_FILE = path.join(APP_DATA_DIR, 'overrides.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(TRASH_DIR, { recursive: true });
if (!fs.existsSync(OVERRIDES_FILE)) fs.writeFileSync(OVERRIDES_FILE, '{}');

// ---------- helpers ----------

function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeOverrides(obj) {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(obj, null, 2));
}

function overrideKey(projectId, sessionId) {
  return `${projectId}::${sessionId}`;
}

function safeProjectDir(projectId) {
  if (!projectId || projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
    throw new Error('invalid project id');
  }
  return path.join(PROJECTS_DIR, projectId);
}

function safeSessionFile(projectId, sessionId) {
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error('invalid session id');
  }
  return path.join(safeProjectDir(projectId), `${sessionId}.jsonl`);
}

function parseJsonlLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function decodeProjectIdGuess(projectId) {
  // Best-effort fallback only; real cwd is preferred when available.
  if (projectId.length > 1 && projectId[1] === '-') {
    return projectId[0] + ':' + projectId.slice(2).replace(/-/g, '\\');
  }
  return projectId.replace(/-/g, '\\');
}

function findCwdForProject(projectDir) {
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(projectDir, f), 'utf8');
      const lines = raw.split('\n').slice(0, 40);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (obj.cwd) return obj.cwd;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function listProjects() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const projects = [];
  for (const d of dirs) {
    const projectId = d.name;
    const projectDir = path.join(PROJECTS_DIR, projectId);
    let jsonlFiles = [];
    try {
      jsonlFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (jsonlFiles.length === 0) continue;
    let lastActivity = 0;
    for (const f of jsonlFiles) {
      try {
        const st = fs.statSync(path.join(projectDir, f));
        if (st.mtimeMs > lastActivity) lastActivity = st.mtimeMs;
      } catch {
        // ignore
      }
    }
    const cwd = findCwdForProject(projectDir) || decodeProjectIdGuess(projectId);
    projects.push({
      id: projectId,
      cwd,
      sessionCount: jsonlFiles.length,
      lastActivity,
    });
  }
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return projects;
}

function firstUserText(lines) {
  for (const l of lines) {
    if (l.type === 'user' && l.message && typeof l.message.content === 'string' && l.message.content.trim()) {
      return l.message.content.trim();
    }
  }
  return '';
}

function summarizeSession(projectId, sessionId, filePath, overrides) {
  const lines = parseJsonlLines(filePath);
  let aiTitle = '';
  let firstTs = null;
  let lastTs = null;
  let cwd = null;
  let messageCount = 0;

  for (const l of lines) {
    if (l.type === 'ai-title' && l.aiTitle) aiTitle = l.aiTitle;
    if (l.cwd && !cwd) cwd = l.cwd;
    if (l.timestamp) {
      if (!firstTs) firstTs = l.timestamp;
      lastTs = l.timestamp;
    }
    if (l.type === 'user' || l.type === 'assistant') messageCount++;
  }

  const st = fs.statSync(filePath);
  const key = overrideKey(projectId, sessionId);
  const override = overrides[key];

  return {
    id: sessionId,
    title: (override && override.title) || aiTitle || firstUserText(lines).slice(0, 80) || '(untitled session)',
    autoTitle: aiTitle || null,
    renamed: !!(override && override.title),
    preview: firstUserText(lines).slice(0, 160),
    messageCount,
    createdAt: firstTs || st.birthtime.toISOString(),
    updatedAt: lastTs || st.mtime.toISOString(),
    cwd: cwd || null,
  };
}

function listSessions(projectId) {
  const projectDir = safeProjectDir(projectId);
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const overrides = readOverrides();
  const sessions = files.map((f) => {
    const sessionId = f.replace(/\.jsonl$/, '');
    return summarizeSession(projectId, sessionId, path.join(projectDir, f), overrides);
  });
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return sessions;
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[image]';
        return JSON.stringify(c);
      })
      .join('\n');
  }
  return content ? JSON.stringify(content) : '';
}

function blocksFromContent(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case 'text':
        if (c.text && c.text.trim()) blocks.push({ type: 'text', text: c.text });
        break;
      case 'thinking':
        if (c.thinking && c.thinking.trim()) blocks.push({ type: 'thinking', text: c.thinking });
        break;
      case 'tool_use':
        blocks.push({ type: 'tool_use', name: c.name, input: c.input });
        break;
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          isError: !!c.is_error,
          content: normalizeToolResultContent(c.content),
        });
        break;
      case 'image':
        blocks.push({ type: 'image_ref' });
        break;
      default:
        break;
    }
  }
  return blocks;
}

function getSessionDetail(projectId, sessionId) {
  const filePath = safeSessionFile(projectId, sessionId);
  const lines = parseJsonlLines(filePath);
  const overrides = readOverrides();
  const key = overrideKey(projectId, sessionId);
  const override = overrides[key];

  let aiTitle = '';
  const messages = [];
  let cwd = null;

  for (const l of lines) {
    if (l.type === 'ai-title' && l.aiTitle) aiTitle = l.aiTitle;
    if (l.cwd && !cwd) cwd = l.cwd;
    if ((l.type === 'user' || l.type === 'assistant') && l.message) {
      const blocks = blocksFromContent(l.message.content);
      if (blocks.length === 0) continue;
      messages.push({
        role: l.message.role || l.type,
        timestamp: l.timestamp || null,
        blocks,
      });
    }
  }

  return {
    id: sessionId,
    projectId,
    title: (override && override.title) || aiTitle || firstUserText(lines).slice(0, 80) || '(untitled session)',
    autoTitle: aiTitle || null,
    renamed: !!(override && override.title),
    cwd,
    messages,
  };
}

function searchAll(query) {
  const q = query.toLowerCase();
  const results = [];
  const projects = listProjects();
  for (const p of projects) {
    const sessions = listSessions(p.id);
    for (const s of sessions) {
      const filePath = safeSessionFile(p.id, s.id);
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (!raw.toLowerCase().includes(q)) continue;

      let snippet = '';
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line.toLowerCase().includes(q)) continue;
        const idx = line.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 60);
        snippet = line.slice(start, idx + q.length + 60);
        break;
      }

      results.push({
        projectId: p.id,
        projectCwd: p.cwd,
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        snippet: snippet || s.preview,
      });
    }
  }
  results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return results;
}

function deleteSession(projectId, sessionId) {
  const src = safeSessionFile(projectId, sessionId);
  const destDir = path.join(TRASH_DIR, projectId);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${sessionId}.jsonl`);
  fs.renameSync(src, dest);
}

function listTrash() {
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const overrides = readOverrides();
  const items = [];
  for (const d of projectDirs) {
    const projectId = d.name;
    const dir = path.join(TRASH_DIR, projectId);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const sessionId = f.replace(/\.jsonl$/, '');
      try {
        const summary = summarizeSession(projectId, sessionId, path.join(dir, f), overrides);
        items.push({ ...summary, projectId });
      } catch {
        // ignore unreadable
      }
    }
  }
  items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return items;
}

function restoreSession(projectId, sessionId) {
  const src = path.join(TRASH_DIR, projectId, `${sessionId}.jsonl`);
  if (!fs.existsSync(src)) throw new Error('not found in trash');
  const destDir = safeProjectDir(projectId);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${sessionId}.jsonl`);
  fs.renameSync(src, dest);
}

function purgeSession(projectId, sessionId) {
  const src = path.join(TRASH_DIR, projectId, `${sessionId}.jsonl`);
  if (!fs.existsSync(src)) throw new Error('not found in trash');
  fs.unlinkSync(src);
}

function renameSession(projectId, sessionId, title) {
  const overrides = readOverrides();
  const key = overrideKey(projectId, sessionId);
  if (title && title.trim()) {
    overrides[key] = { title: title.trim() };
  } else {
    delete overrides[key];
  }
  writeOverrides(overrides);
}

// ---------- HTTP plumbing ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    if (pathname === '/api/projects' && req.method === 'GET') {
      return sendJson(res, 200, listProjects());
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      const projectId = parsed.query.project;
      return sendJson(res, 200, listSessions(projectId));
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const { project, session } = parsed.query;
      return sendJson(res, 200, getSessionDetail(project, session));
    }

    if (pathname === '/api/session' && req.method === 'DELETE') {
      const { project, session } = parsed.query;
      deleteSession(project, session);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/session/rename' && req.method === 'POST') {
      const body = await readBody(req);
      renameSession(body.project, body.session, body.title || '');
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const q = (parsed.query.q || '').trim();
      if (!q) return sendJson(res, 200, []);
      return sendJson(res, 200, searchAll(q));
    }

    if (pathname === '/api/trash' && req.method === 'GET') {
      return sendJson(res, 200, listTrash());
    }

    if (pathname === '/api/trash/restore' && req.method === 'POST') {
      const body = await readBody(req);
      restoreSession(body.project, body.session);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/trash/purge' && req.method === 'POST') {
      const body = await readBody(req);
      purgeSession(body.project, body.session);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Claude chat manager running at http://localhost:${PORT}`);
  console.log(`Reading sessions from: ${PROJECTS_DIR}`);
});
