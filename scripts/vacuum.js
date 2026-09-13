// scripts/vacuum.js — 数据库整理（运维脚本）
//
// 为什么需要：SQLite 的 DELETE 只把页标记为空闲，不会把空间还给操作系统；
// 碎片墓碑化（内容改写成 '[expired]'）也会在原来的页里留下空洞。长期运行下来
// 文件只涨不缩。VACUUM 会重建整个数据库文件，把这些空洞收掉。
//
// ⚠️ 两个代价，脚本会先帮你判断值不值：
//   1. 需要**临时双倍磁盘**（重建期间新旧文件同时存在）
//   2. 全程**独占锁库**，期间服务的写入会被阻塞 —— 所以建议先停服务再跑
//
// 用法：
//   node scripts/vacuum.js              # 检查 → 够划算就执行
//   node scripts/vacuum.js --dry-run    # 只报告能回收多少，不动手
//   node scripts/vacuum.js --force      # 忽略「回收量太小」的判断，强制执行
//
// 挂 cron 的话建议低峰期每周一次，例如：
//   30 4 * * 0  cd /path/to/app && node scripts/vacuum.js >> logs/vacuum.log 2>&1

require('dotenv').config();
const fs = require('fs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const MIN_RECLAIM_MB = 20;   // 回收量低于这个数就不值得锁库重建
const DB_PATH = process.env.DB_PATH || 'sanctuary.db';

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

function fileSize(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}

function freeDiskBytes(dir) {
    try {
        if (typeof fs.statfsSync !== 'function') return null;   // Node < 18.15
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch { return null; }
}

console.log('── 数据库整理 (VACUUM) ──');
console.log('文件:', DB_PATH);

const sizeBefore = fileSize(DB_PATH);
if (!sizeBefore) {
    console.error(`找不到数据库文件 ${DB_PATH}（用 DB_PATH 环境变量指定路径）`);
    process.exit(1);
}
console.log('当前大小:', mb(sizeBefore));

const { initDatabase, getDb } = require('../database');
initDatabase();
const db = getDb();

// ── 1. 估算可回收量 ──
// freelist_count = 已经被整页标记空闲、但还占着文件大小的页数。
// 页内碎片（半空的页）没法用 SQL 便宜地估出来，所以这只是**下限**。
const pageSize = db.pragma('page_size', { simple: true });
const pageCount = db.pragma('page_count', { simple: true });
const freelist = db.pragma('freelist_count', { simple: true });
const reclaimEstimate = freelist * pageSize;

console.log(`页: ${pageCount} × ${pageSize}B，空闲页 ${freelist} → 至少可回收 ${mb(reclaimEstimate)}`);
console.log('（页内碎片收不回来，实际回收量通常高于这个数）');

if (DRY_RUN) {
    console.log('\n--dry-run：只做检查，未执行 VACUUM。');
    process.exit(0);
}

// ── 2. 空间检查 ──
const free = freeDiskBytes('.');
if (free === null) {
    console.warn('⚠️  无法读取磁盘剩余空间（Node < 18.15 或平台不支持），跳过检查。VACUUM 期间请自行确认剩余空间 > ' + mb(sizeBefore));
} else {
    console.log('磁盘剩余:', mb(free));
    const need = sizeBefore * 1.2;   // 新旧文件同时存在 + 一点余量
    if (free < need) {
        console.error(`❌ 剩余空间不足：需要约 ${mb(need)}，实际 ${mb(free)}。`);
        console.error('   先清理磁盘，或用 --force 强行尝试（不建议）。');
        if (!FORCE) process.exit(1);
    }
}

// ── 3. 值不值得做 ──
if (reclaimEstimate < MIN_RECLAIM_MB * 1048576 && !FORCE) {
    console.log(`\n可回收量低于 ${MIN_RECLAIM_MB} MB，重建整个文件的收益不大，跳过。`);
    console.log('（确认要做可以加 --force）');
    process.exit(0);
}

// ── 4. WAL 落盘，然后 VACUUM ──
try {
    db.pragma('wal_checkpoint(TRUNCATE)');
} catch (e) {
    console.warn('wal_checkpoint 失败（可忽略）:', e.message);
}

console.log('\n开始 VACUUM……');
const t0 = Date.now();
try {
    db.exec('VACUUM');
} catch (e) {
    if (/busy|locked/i.test(e.message)) {
        console.error('❌ 数据库被占用（多半是服务还在跑）。先停掉服务再执行：');
        console.error('   pm2 stop <name>   # 或者直接停掉 node index.js');
    } else {
        console.error('❌ VACUUM 失败:', e.message);
    }
    process.exit(1);
}

// VACUUM 的写入先落在 WAL 里，要 checkpoint + 关连接之后文件大小才是最终值
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
db.close();

const sizeAfter = fileSize(DB_PATH);
console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`文件大小：${mb(sizeBefore)} → ${mb(sizeAfter)}（回收 ${mb(sizeBefore - sizeAfter)}）`);
