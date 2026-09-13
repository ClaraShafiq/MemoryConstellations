// =================================================================
// Memory Constellations — 入口文件
// =================================================================

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./database');
const { CONFIG } = require('./config');

const db = initDatabase();

const app = express();
app.set('trust proxy', 1);

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'memory-constellations-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CSRF ──
const csrf = require('csrf');
const tokens = new csrf();
app.set('generateCsrfToken', (req, res) => {
  const secret = tokens.secretSync();
  if (req.session) req.session.csrfSecret = secret;
  return tokens.create(secret);
});

// ── Simple auth middleware ──
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/login') return next();
  res.redirect('/login');
};

// ── Login ──
app.get('/login', (req, res) => {
  // 用 root 形式：express 5 / Windows 下直接传绝对路径会 404
  res.sendFile('login.html', { root: __dirname });
});
app.post('/login', (req, res) => {
  if (req.body.password === process.env.LOGIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/memory.html');
  }
  res.status(401).send('Wrong password');
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Memory page (主页面) ──
app.get('/memory.html', requireAuth, (req, res) => {
  const memoryConfig = require('./memory_config.json');
  const csrfToken = req.app.get('generateCsrfToken')(req, res);
  const html = require('fs').readFileSync(path.join(__dirname, 'memory.html'), 'utf8');
  const configScript = `<script>window.MEMORY_UI_CONFIG = ${JSON.stringify({
    user: { name: memoryConfig.user.name, color: memoryConfig.ui.user_color },
    ai:   { name: memoryConfig.ai.name,   color: memoryConfig.ui.ai_color },
  })};</script>`;
  const injected = html
    .replace('</head>', `<meta name="csrf-token" content="${csrfToken}">\n${configScript}\n</head>`);
  res.type('html').send(injected);
});

// ── Memory API ──
// 注意：memory-api.js 内部写的是完整路径（'/api/memory/...'），这里不能再加前缀，
// 否则实际路径会变成 /api/memory/api/memory/...，前端全部 404。
app.use(require('./routes/memory-api'));

// ── Chat ingest API（接收外部机器人消息，攒记忆）──
app.use('/api', require('./routes/ingest'));

// ── Memory recall API（外部机器人回复前查记忆）──
app.use('/api', require('./routes/recall'));

// ── Import/Export API（memory.html 前端导入导出）──
app.use('/api', require('./routes/import'));

// ── Root redirect ──
app.get('/', requireAuth, (req, res) => res.redirect('/memory.html'));

// ── 静态资源（放在路由之后 + 要求已登录）──
// 以前这一行注册在最前面且没有鉴权，等于把整个项目目录对外开放：
// 未登录就能下载 sanctuary.db / sanctuary.db-wal（整个记忆库）和 memory_config.json。
// 现在必须先通过 requireAuth；登录页由上面的 /login 路由直接发送，不经过这里。
const staticDir = express.static(path.join(__dirname), { index: false, dotfiles: 'deny' });
app.use(requireAuth, staticDir);

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Memory Constellations running at http://localhost:${PORT}/memory.html`);
});
