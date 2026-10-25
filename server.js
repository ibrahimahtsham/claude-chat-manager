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

// ---------- memory ----------
// Claude Code keeps per-project memory in ~/.claude/projects/<id>/memory/:
// one fact per .md file (frontmatter: name, description, type) plus a
// MEMORY.md index that is loaded into every session.

const MEMORY_INDEX = 'MEMORY.md';
const MEMORY_TRASH_DIR = path.join(APP_DATA_DIR, 'memory-trash');
const INDEX_LINE_LIMIT = 200; // only the first 200 lines of MEMORY.md are loaded
const DUPLICATE_THRESHOLD = 0.5;
const STOP_WORDS = new Set(
  'that this from have when with they them their into only also what about your just should then than will been were does there which more'.split(' ')
);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function memoryDir(projectId) {
  return path.join(safeProjectDir(projectId), 'memory');
}

function safeMemoryFile(projectId, file) {
  if (!file || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)) {
    throw httpError(400, 'invalid memory file name (letters, digits, . _ - only, ending in .md)');
  }
  return path.join(memoryDir(projectId), file);
}

function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function unquoteYaml(v) {
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Minimal frontmatter reader: top-level `key: value` pairs plus one level of
// nesting (the `metadata:` block). Enough for memory files, not general YAML.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: raw, hasFrontmatter: false };
  const meta = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, rawVal] = kv;
    const val = unquoteYaml(rawVal.trim());
    if (!indent) {
      if (val === '') {
        meta[key] = {};
        parent = key;
      } else {
        meta[key] = val;
        parent = null;
      }
    } else if (parent) {
      meta[parent][key] = val;
    }
  }
  return { meta, body: raw.slice(m[0].length), hasFrontmatter: true };
}

function indexEntries(indexRaw) {
  const out = [];
  indexRaw.split(/\r?\n/).forEach((text, i) => {
    const re = /\]\(([^)\s]+\.md)\)/g;
    let m;
    while ((m = re.exec(text))) out.push({ line: i + 1, text, target: m[1].replace(/^\.\//, '') });
  });
  return out;
}

function countLines(raw) {
  return raw ? raw.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
}

function wordSet(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOP_WORDS.has(w)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function readMemoryEntry(dir, file, indexedTargets) {
  const p = path.join(dir, file);
  const raw = fs.readFileSync(p, 'utf8');
  const st = fs.statSync(p);
  const { meta, body, hasFrontmatter } = parseFrontmatter(raw);
  const nested = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const description = str(meta.description);
  return {
    file,
    name: str(meta.name),
    description,
    type: str(meta.type) || str(nested.type),
    hasFrontmatter,
    size: st.size,
    mtimeMs: st.mtimeMs,
    indexed: indexedTargets.has(file),
    links: [...new Set([...body.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((x) => x[1].trim()))],
    words: wordSet(`${description} ${body}`),
  };
}

function memoryReport(projectId) {
  const dir = memoryDir(projectId);
  const indexPath = path.join(dir, MEMORY_INDEX);
  const indexExists = fs.existsSync(indexPath);
  const indexRaw = indexExists ? fs.readFileSync(indexPath, 'utf8') : '';
  const entries = indexEntries(indexRaw);
  const indexedTargets = new Set(entries.map((e) => e.target));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== MEMORY_INDEX).sort();
  const fileSet = new Set(files);
  const memories = files.map((f) => readMemoryEntry(dir, f, indexedTargets));
  const names = new Set(memories.map((m) => m.name).filter(Boolean));
  const issues = [];

  const firstSeen = new Map();
  for (const e of entries) {
    if (!fileSet.has(e.target)) {
      issues.push({ level: 'error', kind: 'missing-file', file: e.target, line: e.line,
        message: `MEMORY.md line ${e.line} points to ${e.target}, which does not exist` });
    }
    if (firstSeen.has(e.target)) {
      issues.push({ level: 'warn', kind: 'duplicate-index', file: e.target, line: e.line,
        message: `${e.target} is listed twice in MEMORY.md (lines ${firstSeen.get(e.target)} and ${e.line})` });
    } else {
      firstSeen.set(e.target, e.line);
    }
  }

  for (const m of memories) {
    if (!m.indexed) {
      issues.push({ level: 'warn', kind: 'not-indexed', file: m.file,
        message: `${m.file} is not listed in MEMORY.md, so Claude won't know it exists` });
    }
    const missing = ['name', 'description', 'type'].filter((k) => !m[k]);
    if (!m.hasFrontmatter) {
      issues.push({ level: 'warn', kind: 'frontmatter', file: m.file,
        message: `${m.file} has no frontmatter (name, description, type)` });
    } else if (missing.length) {
      issues.push({ level: 'warn', kind: 'frontmatter', file: m.file,
        message: `${m.file} frontmatter is missing: ${missing.join(', ')}` });
    }
    for (const link of m.links) {
      if (names.has(link) || fileSet.has(link) || fileSet.has(`${link}.md`)) continue;
      issues.push({ level: 'info', kind: 'unwritten-link', file: m.file, link,
        message: `${m.file} links to [[${link}]], which has no memory yet (fine, it marks something worth saving later)` });
    }
  }

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const score = jaccard(memories[i].words, memories[j].words);
      if (score < DUPLICATE_THRESHOLD) continue;
      issues.push({ level: 'warn', kind: 'duplicate', file: memories[i].file, other: memories[j].file,
        message: `${memories[i].file} and ${memories[j].file} look alike (${Math.round(score * 100)}% shared words), maybe merge them` });
    }
  }

  const indexLines = countLines(indexRaw);
  if (indexLines > INDEX_LINE_LIMIT) {
    issues.push({ level: 'warn', kind: 'index-too-long', file: MEMORY_INDEX,
      message: `MEMORY.md has ${indexLines} lines; only the first ${INDEX_LINE_LIMIT} are loaded` });
  }

  const projectDir = safeProjectDir(projectId);
  return {
    projectId,
    cwd: findCwdForProject(projectDir) || decodeProjectIdGuess(projectId),
    index: { exists: indexExists, lines: indexLines, mtimeMs: indexExists ? fs.statSync(indexPath).mtimeMs : null },
    memories: memories.map(({ words, ...m }) => m),
    issues,
  };
}

function listMemoryReports() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const reports = [];
  for (const d of dirs) {
    try {
      if (!fs.statSync(path.join(PROJECTS_DIR, d.name, 'memory')).isDirectory()) continue;
      reports.push(memoryReport(d.name));
    } catch {
      // no memory folder, or unreadable
    }
  }
  return reports;
}

function readMemoryFile(projectId, file) {
  const p = safeMemoryFile(projectId, file);
  if (!fs.existsSync(p)) {
    if (file === MEMORY_INDEX) return { file, content: '', mtimeMs: null };
    throw httpError(404, `${file} not found`);
  }
  return { file, content: fs.readFileSync(p, 'utf8'), mtimeMs: fs.statSync(p).mtimeMs };
}

function humanize(slug) {
  const words = slug.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readIndex(projectId) {
  const p = path.join(memoryDir(projectId), MEMORY_INDEX);
  return { p, raw: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' };
}

function appendIndexLines(projectId, lines) {
  if (!lines.length) return;
  const { p, raw } = readIndex(projectId);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const prefix = raw && !raw.endsWith('\n') ? eol : '';
  writeFileAtomic(p, raw + prefix + lines.join(eol) + eol);
}

function addIndexLine(projectId, file) {
  if (indexEntries(readIndex(projectId).raw).some((e) => e.target === file)) return false;
  const { meta } = parseFrontmatter(fs.readFileSync(safeMemoryFile(projectId, file), 'utf8'));
  const title = humanize(typeof meta.name === 'string' && meta.name ? meta.name : file);
  const desc = typeof meta.description === 'string' ? meta.description : '';
  appendIndexLines(projectId, [`- [${title}](${file})${desc ? ` — ${desc}` : ''}`]);
  return true;
}

function removeIndexLines(projectId, file) {
  const { p, raw } = readIndex(projectId);
  if (!raw) return [];
  const linked = new Set(indexEntries(raw).filter((e) => e.target === file).map((e) => e.line));
  if (!linked.size) return [];
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const removed = lines.filter((_, i) => linked.has(i + 1));
  writeFileAtomic(p, lines.filter((_, i) => !linked.has(i + 1)).join(eol));
  return removed;
}

function saveMemoryFile({ project, file, content, expectedMtime, create }) {
  const p = safeMemoryFile(project, file);
  if (typeof content !== 'string') throw httpError(400, 'content must be text');
  const exists = fs.existsSync(p);
  if (create && exists) throw httpError(409, `${file} already exists, pick another file name`);
  if (exists && !create && expectedMtime != null && fs.statSync(p).mtimeMs !== expectedMtime) {
    throw httpError(409, `${file} changed on disk since you opened it (Claude may have updated it). Revert to load the new version.`);
  }
  // Keep the file's existing line endings; the browser always sends \n.
  const crlf = exists && fs.readFileSync(p, 'utf8').includes('\r\n');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, crlf ? content.replace(/\r?\n/g, '\r\n') : content);
  const indexed = create && file !== MEMORY_INDEX ? addIndexLine(project, file) : false;
  return { mtimeMs: fs.statSync(p).mtimeMs, indexed };
}

function deleteMemoryFile(project, file) {
  if (file === MEMORY_INDEX) throw httpError(400, 'MEMORY.md cannot be deleted, edit it instead');
  const src = safeMemoryFile(project, file);
  if (!fs.existsSync(src)) throw httpError(404, `${file} not found`);
  const destDir = path.join(MEMORY_TRASH_DIR, project);
  fs.mkdirSync(destDir, { recursive: true });
  const id = `${Date.now()}__${file}`;
  fs.renameSync(src, path.join(destDir, id));
  const removed = removeIndexLines(project, file);
  fs.writeFileSync(path.join(destDir, `${id}.json`), JSON.stringify({ file, indexLines: removed, deletedAt: new Date().toISOString() }, null, 2));
  return { removedIndexLines: removed.length };
}

function memoryTrashPath(project, id) {
  safeProjectDir(project);
  if (!/^\d+__[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(id || '')) throw httpError(400, 'invalid trash id');
  return path.join(MEMORY_TRASH_DIR, project, id);
}

function listMemoryTrash() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(MEMORY_TRASH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const items = [];
  for (const d of dirs) {
    const dir = path.join(MEMORY_TRASH_DIR, d.name);
    for (const id of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      } catch {
        // metadata missing; fall back to the file name
      }
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, id), 'utf8'));
      items.push({
        projectId: d.name,
        id,
        file: info.file || id.slice(id.indexOf('__') + 2),
        description: typeof meta.description === 'string' ? meta.description : '',
        deletedAt: info.deletedAt || null,
      });
    }
  }
  items.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  return items;
}

function restoreMemoryFile(project, id) {
  const src = memoryTrashPath(project, id);
  if (!fs.existsSync(src)) throw httpError(404, 'not found in memory trash');
  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(`${src}.json`, 'utf8'));
  } catch {
    // no saved index lines
  }
  const file = info.file || id.slice(id.indexOf('__') + 2);
  const dest = safeMemoryFile(project, file);
  if (fs.existsSync(dest)) throw httpError(409, `${file} already exists in memory`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  fs.rmSync(`${src}.json`, { force: true });
  if (Array.isArray(info.indexLines) && info.indexLines.length) appendIndexLines(project, info.indexLines);
  else addIndexLine(project, file);
  return { file };
}

function purgeMemoryFile(project, id) {
  const src = memoryTrashPath(project, id);
  if (!fs.existsSync(src)) throw httpError(404, 'not found in memory trash');
  fs.unlinkSync(src);
  fs.rmSync(`${src}.json`, { force: true });
}

// Memory files are read by Claude as instructions, so writes are only taken
// from this computer, as JSON (forces a CORS preflight that other sites
// can't pass), addressed to localhost (blocks DNS rebinding).
function assertLocalWrite(req) {
  const addr = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
    throw httpError(403, 'memory can only be changed from this computer');
  }
  const host = (req.headers.host || '').toLowerCase();
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(host)) {
    throw httpError(403, 'unexpected host');
  }
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw httpError(415, 'expected application/json');
  }
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

    if (pathname === '/api/memory' && req.method === 'GET') {
      return sendJson(res, 200, { projects: listMemoryReports() });
    }

    if (pathname === '/api/memory/file' && req.method === 'GET') {
      return sendJson(res, 200, readMemoryFile(parsed.query.project, parsed.query.file));
    }

    if (pathname === '/api/memory/trash' && req.method === 'GET') {
      return sendJson(res, 200, listMemoryTrash());
    }

    if (pathname.startsWith('/api/memory/') && req.method === 'POST') {
      assertLocalWrite(req);
      const body = await readBody(req);
      switch (pathname) {
        case '/api/memory/save':
          return sendJson(res, 200, saveMemoryFile(body));
        case '/api/memory/delete':
          return sendJson(res, 200, deleteMemoryFile(body.project, body.file));
        case '/api/memory/index/add':
          safeMemoryFile(body.project, body.file);
          return sendJson(res, 200, { added: addIndexLine(body.project, body.file) });
        case '/api/memory/index/remove':
          safeMemoryFile(body.project, body.file);
          return sendJson(res, 200, { removed: removeIndexLines(body.project, body.file).length });
        case '/api/memory/restore':
          return sendJson(res, 200, restoreMemoryFile(body.project, body.id));
        case '/api/memory/purge':
          purgeMemoryFile(body.project, body.id);
          return sendJson(res, 200, { ok: true });
        default:
          break;
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Claude chat manager running at http://localhost:${PORT}`);
  console.log(`Reading sessions from: ${PROJECTS_DIR}`);
});
