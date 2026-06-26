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

// Static files
app.use(express.static(path.join(__dirname)));

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
  res.sendFile(path.join(__dirname, 'login.html'));
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
  const namePatch = `<script>document.addEventListener('DOMContentLoaded',()=>{
    const n=window.MEMORY_UI_CONFIG;
    if(!n)return;
    const fix=t=>t.replace(/Draco/g,n.ai.name).replace(/Clara/g,n.user.name);
    const sub=document.querySelector('.arch-sub');
    if(sub)sub.textContent=fix(sub.textContent);
    const title=document.querySelector('.mq-title');
    if(title)title.textContent=fix(title.textContent);
    const editor=document.getElementById('ci-editor');
    if(editor)editor.placeholder=fix(editor.placeholder);
  });</script>`;
  const injected = html
    .replace('</head>', `<meta name="csrf-token" content="${csrfToken}">\n${configScript}\n</head>`)
    .replace('</body>', `${namePatch}\n</body>`);
  res.type('html').send(injected);
});

// ── Memory API ──
app.use('/api/memory', require('./routes/memory-api'));

// ── Root redirect ──
app.get('/', requireAuth, (req, res) => res.redirect('/memory.html'));

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Memory Constellations running at http://localhost:${PORT}/memory.html`);
});
