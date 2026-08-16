// routes/auth.js — 身份验证中间件
// 供 routes/memory-api.js 等需要登录保护的路由使用。
// 登录态由 index.js 的 express-session 维护（登录成功设 req.session.authenticated = true）。

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.redirect('/login');
}

module.exports = { requireAuth };
