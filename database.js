// =================================================================
// 数据库初始化 + 版本化迁移
// =================================================================

const Database = require('better-sqlite3');
const { encryption } = require('./encryption');

let db;
let _initialized = false;

// 迁移辅助：版本号 + 幂等检测
function runMigration(version, name, sql, options = {}) {
    const recorded = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version);
    if (recorded) return;

    try {
        db.exec(sql);
        db.prepare('INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, name, new Date().toISOString());
        if (!options.silent) console.log(`[DB] v${version} ${name} ✓`);
    } catch (e) {
        // "已存在"类错误 = 旧版已手动执行过，记录版本号后跳过
        const isAlreadyExists = /duplicate column|already exists|duplicate key/i.test(e.message);
        if (isAlreadyExists) {
            db.prepare('INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
              .run(version, name, new Date().toISOString());
            if (!options.silent) console.log(`[DB] v${version} ${name} (已存在，标记跳过)`);
        } else {
            console.error(`[DB] v${version} ${name} 失败:`, e.message);
            if (options.critical) throw e;
        }
    }
}

function initDatabase() {
    // 单例缓存：避免重复连接 + 重复跑迁移
    if (_initialized && db) return db;

    db = new Database('sanctuary.db');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // ── v0: 基础表（IF NOT EXISTS，永远安全） ──
    const createTables = [
        `CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )`,

        `CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            warning_38k_sent BOOLEAN DEFAULT 0,
            warning_40k_sent BOOLEAN DEFAULT 0,
            current_draco_status TEXT DEFAULT '在线',
            status_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            sender TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_encrypted BOOLEAN DEFAULT 1,
            images TEXT,
            is_tagged BOOLEAN DEFAULT 0,
            message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'voice', 'proactive')),
            status TEXT DEFAULT 'sent' CHECK(status IN ('draft', 'sent')),
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS api_usage_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL,
            api_calls INTEGER DEFAULT 1,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            model_name TEXT,
            chat_id INTEGER,
            request_type TEXT DEFAULT 'message',
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE SET NULL
        )`,

        `CREATE TABLE IF NOT EXISTS moments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author TEXT NOT NULL CHECK(author IN ('clara', 'draco')),
            content TEXT NOT NULL,
            chat_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            images TEXT,
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE SET NULL
        )`,

        `CREATE TABLE IF NOT EXISTS moment_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (moment_id) REFERENCES moments (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS moment_likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (moment_id) REFERENCES moments (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS user_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT UNIQUE NOT NULL,
            setting_value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS worldbooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            injection_position TEXT NOT NULL CHECK(injection_position IN ('before', 'after')),
            is_enabled BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS tool_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            input_params TEXT,
            output_result TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS health_data (
            date TEXT PRIMARY KEY,
            resting_hr INTEGER,
            hr_out_of_range_min INTEGER,
            hr_fat_burn_min INTEGER,
            hr_cardio_min INTEGER,
            hr_peak_min INTEGER,
            hrv_daily REAL,
            hrv_deep REAL,
            sleep_total_min INTEGER,
            sleep_deep_min INTEGER,
            sleep_light_min INTEGER,
            sleep_rem_min INTEGER,
            sleep_wake_min INTEGER,
            sleep_efficiency INTEGER,
            sleep_start_time TEXT,
            sleep_end_time TEXT,
            steps INTEGER,
            distance REAL,
            active_min_light INTEGER,
            active_min_moderate INTEGER,
            active_min_vigorous INTEGER,
            sedentary_min INTEGER,
            calories_out INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS health_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            domain TEXT NOT NULL,
            trigger TEXT NOT NULL,
            memo TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS api_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('gemini', 'openai_compatible')),
            endpoint TEXT NOT NULL,
            api_key TEXT NOT NULL,
            model_name TEXT NOT NULL,
            is_default INTEGER DEFAULT 0,
            supports_tools INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS chat_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            start_message_id INTEGER NOT NULL,
            end_message_id INTEGER NOT NULL,
            round_start INTEGER NOT NULL,
            round_end INTEGER NOT NULL,
            summary_text TEXT NOT NULL,
            token_count INTEGER,
            is_enabled BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT,
            content_hash TEXT,
            chroma_id TEXT,
            weight INTEGER DEFAULT 5,
            valid_from TEXT,
            valid_to TEXT,
            status TEXT DEFAULT 'permanent' CHECK(status IN ('permanent', 'ongoing', 'completed')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS draco_inner_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp     TEXT NOT NULL,
            decision_type TEXT NOT NULL,
            intent        TEXT DEFAULT '',
            observation   TEXT DEFAULT '',
            reason        TEXT DEFAULT '',
            tick_id       TEXT DEFAULT ''
        )`,
        `CREATE TABLE IF NOT EXISTS draco_working_memory (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            author TEXT,
            format TEXT NOT NULL CHECK(format IN ('epub', 'txt')),
            file_path TEXT NOT NULL,
            cover_image TEXT,
            api_config_name TEXT,
            total_chunks INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS book_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            chapter_title TEXT,
            content TEXT NOT NULL,
            FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS book_reading_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL UNIQUE,
            current_chunk_index INTEGER DEFAULT 0,
            cumulative_summary TEXT DEFAULT '',
            last_read_at DATETIME,
            FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS book_annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            passage TEXT,
            short_label TEXT,
            content TEXT NOT NULL,
            author TEXT NOT NULL CHECK(author IN ('draco', 'clara')),
            parent_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES book_annotations (id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS snitch_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            source TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS snitch_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL DEFAULT 'bot',
            bot_id TEXT,
            title TEXT,
            body TEXT NOT NULL,
            image_url TEXT,
            source_url TEXT,
            source_label TEXT,
            tag TEXT,
            comments INTEGER DEFAULT 0,
            reposts INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS snitch_fetched_urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS snitch_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES snitch_posts(id) ON DELETE CASCADE
        )`,

        `CREATE TABLE IF NOT EXISTS snitch_post_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            title TEXT,
            body TEXT NOT NULL,
            source_url TEXT,
            source_label TEXT,
            tag TEXT,
            image_url TEXT,
            priority TEXT DEFAULT 'later' CHECK(priority IN ('now', 'later')),
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            release_after DATETIME,
            released_at DATETIME,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'released', 'discarded'))
        )`
    ];

    createTables.forEach(sql => db.exec(sql));

    // ── 索引（IF NOT EXISTS，永远安全） ──
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_health_data_date ON health_data(date)',
        'CREATE INDEX IF NOT EXISTS idx_health_events_date ON health_events(date)',
        'CREATE INDEX IF NOT EXISTS idx_health_events_domain ON health_events(domain)',
        'CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags)',
        'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)',
        'CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)',
        'CREATE INDEX IF NOT EXISTS idx_memories_chroma_id ON memories(chroma_id)',
        'CREATE INDEX IF NOT EXISTS idx_draco_inner_log_timestamp ON draco_inner_log(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_book_chunks_book_id ON book_chunks(book_id, chunk_index)',
        'CREATE INDEX IF NOT EXISTS idx_book_annotations_book_id ON book_annotations(book_id, chunk_index)',
        'CREATE INDEX IF NOT EXISTS idx_book_annotations_parent ON book_annotations(parent_id)',
        'CREATE INDEX IF NOT EXISTS idx_snitch_posts_created_at ON snitch_posts(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_snitch_comments_post_id ON snitch_comments(post_id)',
    ];
    indexes.forEach(sql => { try { db.exec(sql); } catch (e) { console.warn('[DB] 索引创建警告:', e.message); } });

    // ── 默认数据 ──
    try {
        const existingConfig = db.prepare('SELECT COUNT(*) as count FROM api_configs').get();
        if (existingConfig.count === 0) {
            db.prepare(`
                INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                'Gemini官方', 'gemini',
                'https://generativelanguage.googleapis.com/v1beta/models/',
                process.env.GEMINI_API_KEY || '',
                'gemini-2.0-flash-exp', 1, 1
            );
            console.log('[DB] 已插入默认API配置');
        }
    } catch (e) { console.error('[DB] 默认API配置失败:', e.message); }

    try {
        db.prepare("INSERT OR IGNORE INTO user_settings (setting_key, setting_value) VALUES ('summary-context-limit', '5')").run();
    } catch (e) { console.error('[DB] 默认设置失败:', e.message); }

    try {
        const botChannel = db.prepare('SELECT id FROM chats WHERE id = 2').get();
        if (!botChannel) {
            db.prepare('INSERT INTO chats (id, name, type) VALUES (2, \'有求必应屋\', \'bot\')').run();
            console.log('[DB] 已创建Bot频道');
        }
    } catch (e) { console.error('[DB] Bot频道创建失败:', e.message); }

    // ── CJK 函数（每次注册，幂等） ──
    db.function('splitCJK', (text) => {
        if (!text) return '';
        return text.replace(/[一-鿿㐀-䶿豈-﫿]/g, ' $& ');
    });

    // ═══════════════════════════════════════════════════════════
    // 版本化迁移 — 每条只跑一次
    // ═══════════════════════════════════════════════════════════

    // v1: 早期表结构扩展
    runMigration(1, 'draco_inner_log.tick_id',
        "ALTER TABLE draco_inner_log ADD COLUMN tick_id TEXT DEFAULT ''");

    runMigration(2, 'messages.message_type',
        "ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'voice', 'proactive'))");

    runMigration(3, 'chats.last_summary_message_id',
        'ALTER TABLE chats ADD COLUMN last_summary_message_id INTEGER DEFAULT 0');

    runMigration(4, 'chats.summary_interval',
        'ALTER TABLE chats ADD COLUMN summary_interval INTEGER DEFAULT 50');

    runMigration(5, 'chats.type',
        "ALTER TABLE chats ADD COLUMN type TEXT DEFAULT 'text'");

    runMigration(6, 'book_reading_progress.clara_chunk_index',
        'ALTER TABLE book_reading_progress ADD COLUMN clara_chunk_index INTEGER DEFAULT 0');

    runMigration(7, 'book_reading_progress.clara_scroll_pct',
        'ALTER TABLE book_reading_progress ADD COLUMN clara_scroll_pct REAL DEFAULT 0');

    // v8-v9: Snitch 扩展
    runMigration(8, 'snitch_post_queue.release_after',
        'ALTER TABLE snitch_post_queue ADD COLUMN release_after DATETIME');

    runMigration(9, 'snitch_comments.parent_id',
        'ALTER TABLE snitch_comments ADD COLUMN parent_id INTEGER');

    // v10-v15: Memory fragments 扩展
    runMigration(10, 'memory_fragments.read_count',
        'ALTER TABLE memory_fragments ADD COLUMN read_count INTEGER DEFAULT 0');

    runMigration(11, 'memory_fragments.last_accessed_at',
        'ALTER TABLE memory_fragments ADD COLUMN last_accessed_at DATETIME');

    runMigration(12, 'memory_fragments.source_msg_ids',
        "ALTER TABLE memory_fragments ADD COLUMN source_msg_ids TEXT DEFAULT '[]'");

    runMigration(13, 'memory_fragments.layer',
        "ALTER TABLE memory_fragments ADD COLUMN layer TEXT DEFAULT 'event'");

    runMigration(14, 'memory_fragments.lifecycle_updated_at',
        'ALTER TABLE memory_fragments ADD COLUMN lifecycle_updated_at DATETIME');

    runMigration(15, 'memories.source_msg_ids',
        "ALTER TABLE memories ADD COLUMN source_msg_ids TEXT DEFAULT '[]'");

    // v16-v17: Memories 扩展
    runMigration(16, 'memories.last_accessed_at',
        'ALTER TABLE memories ADD COLUMN last_accessed_at DATETIME');

    runMigration(17, 'memories.layer',
        "ALTER TABLE memories ADD COLUMN layer TEXT DEFAULT 'episode'");

    // v18-v20: Consolidation + bookmarks + intents
    runMigration(18, 'consolidation_runs',
        `CREATE TABLE IF NOT EXISTS consolidation_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fragments_checked INTEGER DEFAULT 0,
            groups_consolidated INTEGER DEFAULT 0,
            memories_written INTEGER DEFAULT 0,
            status TEXT DEFAULT 'done',
            run_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(19, 'consolidation_runs.memories_skipped',
        'ALTER TABLE consolidation_runs ADD COLUMN memories_skipped INTEGER DEFAULT 0');

    runMigration(20, 'snitch_bookmarks',
        `CREATE TABLE IF NOT EXISTS snitch_bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES snitch_posts(id) ON DELETE CASCADE
        )`);

    // v21-v23: Bot/Snitch 交互表
    runMigration(21, 'draco_snitch_reads',
        `CREATE TABLE IF NOT EXISTS draco_snitch_reads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES snitch_posts(id) ON DELETE CASCADE
        )`);

    runMigration(22, 'bot_snitch_actions',
        `CREATE TABLE IF NOT EXISTS bot_snitch_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            post_id INTEGER NOT NULL,
            last_read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen_comment_id INTEGER DEFAULT 0,
            comment_count INTEGER DEFAULT 0,
            UNIQUE(bot_id, post_id),
            FOREIGN KEY (post_id) REFERENCES snitch_posts(id) ON DELETE CASCADE
        )`);

    runMigration(23, 'bot_snitch_sessions',
        `CREATE TABLE IF NOT EXISTS bot_snitch_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            session_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            posts_seen INTEGER DEFAULT 0,
            comments_made INTEGER DEFAULT 0
        )`);

    // v24: Intents
    runMigration(24, 'draco_intents',
        `CREATE TABLE IF NOT EXISTS draco_intents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intent_type TEXT NOT NULL,
            rough_window TEXT NOT NULL,
            reason TEXT NOT NULL,
            weight REAL DEFAULT 0.5,
            status TEXT DEFAULT 'pending',
            created_at TEXT NOT NULL,
            window_start TEXT,
            window_end TEXT,
            executed_at TEXT
        )`);

    // v25-v27: Memory saga + entity + correction
    runMigration(25, 'memory_sagas',
        `CREATE TABLE IF NOT EXISTS memory_sagas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            memory_ids TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(26, 'entity_profiles',
        `CREATE TABLE IF NOT EXISTS entity_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT 'person',
            current_status TEXT,
            status_since TEXT,
            source_fragment_ids TEXT DEFAULT '[]',
            aliases TEXT DEFAULT '[]',
            relationship_to_clara TEXT,
            relationship_nature TEXT,
            emotional_significance TEXT,
            first_mentioned_date TEXT,
            last_mentioned_date TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(27, 'correction_log',
        `CREATE TABLE IF NOT EXISTS correction_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_id INTEGER,
            wrong_summary TEXT NOT NULL,
            correct_summary TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            chat_message_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    // v28-v36: Cinema 系统
    runMigration(28, 'cinema_watch_status',
        `CREATE TABLE IF NOT EXISTS cinema_watch_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder TEXT NOT NULL,
            file TEXT NOT NULL,
            marked_by TEXT DEFAULT 'manual' CHECK(marked_by IN ('manual', 'auto')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(folder, file)
        )`);

    runMigration(29, 'cinema_danmaku',
        `CREATE TABLE IF NOT EXISTS cinema_danmaku (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            sender TEXT NOT NULL CHECK(sender IN ('clara', 'draco')),
            content TEXT NOT NULL,
            video_timestamp TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )`);

    runMigration(30, 'cinema_plot_segments',
        `CREATE TABLE IF NOT EXISTS cinema_plot_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            segment_id INTEGER NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            plot_summary TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(file_path, segment_id)
        )`);

    runMigration(31, 'cinema_episode_summaries',
        `CREATE TABLE IF NOT EXISTS cinema_episode_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL UNIQUE,
            summary_text TEXT NOT NULL,
            token_count INTEGER DEFAULT 0,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(32, 'cinema_series_summaries',
        `CREATE TABLE IF NOT EXISTS cinema_series_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            series_folder TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            last_episode_file TEXT,
            token_count INTEGER DEFAULT 0,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(33, 'cinema_progress',
        `CREATE TABLE IF NOT EXISTS cinema_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL UNIQUE,
            last_position TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(34, 'cinema_danmaku_archives',
        `CREATE TABLE IF NOT EXISTS cinema_danmaku_archives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            archive_range TEXT,
            original_count INTEGER DEFAULT 0,
            archived_summary TEXT NOT NULL,
            token_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )`);

    runMigration(35, 'cinema_subtitle_config',
        `CREATE TABLE IF NOT EXISTS cinema_subtitle_config (
            file_path TEXT PRIMARY KEY,
            source TEXT DEFAULT 'cloud' CHECK(source IN ('cloud','local','stt')),
            local_sub_path TEXT,
            offset_seconds REAL DEFAULT 0
        )`);

    runMigration(36, 'cinema_film_meta',
        `CREATE TABLE IF NOT EXISTS cinema_film_meta (
            folder TEXT PRIMARY KEY,
            title TEXT,
            overview TEXT,
            poster_path TEXT,
            cast_json TEXT DEFAULT '[]',
            director TEXT,
            year INTEGER,
            tmdb_id INTEGER,
            manual_notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(37, 'cinema_film_meta.poster_local',
        'ALTER TABLE cinema_film_meta ADD COLUMN poster_local TEXT');

    // v38: books.finished_note
    runMigration(38, 'books.finished_note',
        'ALTER TABLE books ADD COLUMN finished_note TEXT');

    // ── v39: Layer 回填（数据迁移，非 DDL） ──
    runMigration(39, 'layer_backfill', '', { silent: true });  // 占位，实际逻辑见下方
    try {
        const fragsNull = db.prepare("SELECT COUNT(*) as c FROM memory_fragments WHERE layer IS NULL OR layer = ''").get();
        if (fragsNull.c > 0) {
            db.exec("UPDATE memory_fragments SET layer = 'event' WHERE layer IS NULL OR layer = ''");
            console.log(`[DB] v39 回填 ${fragsNull.c} 条 fragments → layer='event'`);
        }
        const memsNull = db.prepare("SELECT COUNT(*) as c FROM memories WHERE layer IS NULL OR layer = ''").get();
        if (memsNull.c > 0) {
            const updated = db.prepare("UPDATE memories SET layer = 'episode' WHERE (layer IS NULL OR layer = '') AND source_msg_ids IS NOT NULL AND source_msg_ids != '[]'").run();
            console.log(`[DB] v39 回填 ${updated.changes} 条 memories → layer='episode'`);
        }
    } catch (e) {
        console.error('[DB] v39 layer 回填失败:', e.message);
    }

    // v40: API Key 加密迁移
    runMigration(40, 'api_key_encrypt', '', { silent: true });
    try {
        const configs = db.prepare('SELECT id, api_key FROM api_configs').all();
        let migratedCount = 0;
        configs.forEach(config => {
            if (config.api_key && !config.api_key.startsWith('enc:')) {
                const encryptedKey = encryption.encrypt(config.api_key);
                db.prepare('UPDATE api_configs SET api_key = ? WHERE id = ?').run(encryptedKey, config.id);
                migratedCount++;
            }
        });
        if (migratedCount > 0) console.log(`[DB] v40 已加密 ${migratedCount} 个明文API Key`);
    } catch (e) {
        console.error('[DB] v40 API Key加密迁移失败:', e.message);
    }

    // v41: 话题工作记忆池持久化表
    runMigration(41, 'working_memory_pool', `
        CREATE TABLE IF NOT EXISTS working_memory_pool (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            fragment_key          TEXT NOT NULL UNIQUE,
            content               TEXT NOT NULL,
            emotional_weight      REAL DEFAULT 0.5,
            last_rrf              REAL DEFAULT 0,
            topic_embedding_json  TEXT DEFAULT '[]',
            boosted_at            INTEGER NOT NULL
        )
    `);

    // v42: cinema_subtitle_config 多轨道支持
    runMigration(42, 'cinema_subtitle_config.tracks_json',
        'ALTER TABLE cinema_subtitle_config ADD COLUMN tracks_json TEXT DEFAULT \'[]\'');
    runMigration(43, 'cinema_subtitle_config.active_track_index',
        'ALTER TABLE cinema_subtitle_config ADD COLUMN active_track_index INTEGER DEFAULT 0');

    // ── v44: 记忆架构基表 + FTS5 + CHECK 约束修复（合并） ──
    // 解决三个问题：
    //   1. memory_fragments / scribe_runs 基表不在 migration 系统中
    //   2. FTS5 虚拟表和触发器不在 migration 系统中
    //   3. memories.status CHECK 约束缺少 'mature' / 'archived'
    runMigration(44, 'memory architecture: base tables + FTS5 + CHECK fix', `
        -- ① memory_fragments 基表（含 v10-v14 追加的全部字段）
        CREATE TABLE IF NOT EXISTS memory_fragments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            entity TEXT NOT NULL,
            content TEXT NOT NULL,
            emotional_weight REAL DEFAULT 0.5,
            source TEXT DEFAULT 'chat',
            source_date TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            read_count INTEGER DEFAULT 0,
            last_accessed_at DATETIME,
            chroma_id TEXT,
            source_msg_ids TEXT DEFAULT '[]',
            layer TEXT DEFAULT 'event',
            lifecycle_updated_at DATETIME,
            entity_id INTEGER
        );

        -- ② scribe_runs 基表
        CREATE TABLE IF NOT EXISTS scribe_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            processed_until DATETIME,
            messages_processed INTEGER DEFAULT 0,
            fragments_written INTEGER DEFAULT 0,
            status TEXT DEFAULT 'done'
        );

        -- ③ FTS5 虚拟表
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts
            USING fts5(content, entity, content='memory_fragments', content_rowid='id');

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
            USING fts5(title, tags_text);

        -- ④ memory_fragments_fts 触发器（content-sync 模式，用 splitCJK 分词）
        -- 先删后建，确保触发器与源码一致（IF NOT EXISTS 会导致旧版本永久残留）
        DROP TRIGGER IF EXISTS mf_fts_insert;
        CREATE TRIGGER mf_fts_insert
            AFTER INSERT ON memory_fragments BEGIN
                INSERT INTO memory_fragments_fts(rowid, content, entity)
                VALUES (new.id, splitCJK(new.content), splitCJK(COALESCE(new.entity, '')));
            END;

        DROP TRIGGER IF EXISTS mf_fts_update;
        CREATE TRIGGER mf_fts_update
            AFTER UPDATE ON memory_fragments BEGIN
                UPDATE memory_fragments_fts
                SET content = splitCJK(new.content), entity = splitCJK(COALESCE(new.entity, ''))
                WHERE rowid = new.id;
            END;

        DROP TRIGGER IF EXISTS mf_fts_delete;
        CREATE TRIGGER mf_fts_delete
            AFTER DELETE ON memory_fragments BEGIN
                DELETE FROM memory_fragments_fts WHERE rowid = old.id;
            END;

        -- ⑤ memories_fts 触发器（独立表模式，内联 REPLACE 展开 tags JSON）
        DROP TRIGGER IF EXISTS memories_fts_insert;
        CREATE TRIGGER memories_fts_insert
            AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, title, tags_text)
                VALUES (new.id, COALESCE(new.title, ''),
                    COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), ''));
            END;

        DROP TRIGGER IF EXISTS memories_fts_update;
        CREATE TRIGGER memories_fts_update
            AFTER UPDATE ON memories BEGIN
                UPDATE memories_fts
                SET title = COALESCE(new.title, ''),
                    tags_text = COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), '')
                WHERE rowid = new.id;
            END;

        DROP TRIGGER IF EXISTS memories_fts_delete;
        CREATE TRIGGER memories_fts_delete
            AFTER DELETE ON memories BEGIN
                DELETE FROM memories_fts WHERE rowid = old.id;
            END;
    `);

    // ── v45: memories 表 CHECK 约束修复 ──
    // SQLite 不支持 ALTER CHECK，需要重建表
    // 用事务保护：中途失败自动回滚，不会丢数据
    runMigration(45, 'memories CHECK constraint: add mature/archived', `
        BEGIN;

        -- 删除旧触发器（引用旧表）
        DROP TRIGGER IF EXISTS memories_fts_insert;
        DROP TRIGGER IF EXISTS memories_fts_update;
        DROP TRIGGER IF EXISTS memories_fts_delete;

        -- 重建 memories 表（完整字段 + 修正后的 CHECK）
        CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT,
            content_hash TEXT,
            chroma_id TEXT,
            weight INTEGER DEFAULT 5,
            valid_from TEXT,
            valid_to TEXT,
            status TEXT DEFAULT 'permanent'
                CHECK(status IN ('permanent', 'ongoing', 'completed', 'mature', 'archived')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            source_msg_ids TEXT DEFAULT '[]',
            layer TEXT DEFAULT 'episode',
            last_accessed_at DATETIME
        );

        -- 迁移数据
        INSERT INTO memories_new SELECT * FROM memories;

        -- 替换旧表
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;

        -- 重建索引
        CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
        CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
        CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
        CREATE INDEX IF NOT EXISTS idx_memories_chroma_id ON memories(chroma_id);

        -- 重建触发器
        CREATE TRIGGER memories_fts_insert
            AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, title, tags_text)
                VALUES (new.id, COALESCE(new.title, ''),
                    COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), ''));
            END;

        CREATE TRIGGER memories_fts_update
            AFTER UPDATE ON memories BEGIN
                UPDATE memories_fts
                SET title = COALESCE(new.title, ''),
                    tags_text = COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags, '["', ''), '"]', ''), '","', ' '), '"', ''), '')
                WHERE rowid = new.id;
            END;

        CREATE TRIGGER memories_fts_delete
            AFTER DELETE ON memories BEGIN
                DELETE FROM memories_fts WHERE rowid = old.id;
            END;

        COMMIT;
    `);

    // v46: chats.is_rp_mode
    runMigration(46, 'chats.is_rp_mode',
        'ALTER TABLE chats ADD COLUMN is_rp_mode INTEGER DEFAULT 0');

    // v47: memory_fragments.is_rp
    runMigration(47, 'memory_fragments.is_rp',
        'ALTER TABLE memory_fragments ADD COLUMN is_rp INTEGER DEFAULT 0');

    // v48: messages.is_rp
    runMigration(48, 'messages.is_rp',
        'ALTER TABLE messages ADD COLUMN is_rp INTEGER DEFAULT 0');

    runMigration(50, 'messages.source',
        "ALTER TABLE messages ADD COLUMN source TEXT DEFAULT NULL");

    runMigration(49, 'cinema_reviews',
        `CREATE TABLE IF NOT EXISTS cinema_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder TEXT NOT NULL,
          file_path TEXT,
          film_name TEXT NOT NULL,
          film_type TEXT DEFAULT 'movie',
          clara_rating INTEGER,
          clara_review TEXT,
          draco_rating INTEGER,
          draco_review TEXT,
          watched_date TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);

    runMigration(51, 'personal_places',
        `CREATE TABLE IF NOT EXISTS personal_places (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('restaurant','cafe','dessert','bookstore','company','home','other')),
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          address TEXT,
          visit_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

    // v52: memory_sagas.emotional_axis — Saga 情感主轴，驱动 jiwen 偏置
    runMigration(52, 'memory_sagas.emotional_axis',
        "ALTER TABLE memory_sagas ADD COLUMN emotional_axis TEXT DEFAULT NULL");

    // v53: memories.consolidation_type — 区分 standard / flash 整合
    runMigration(53, 'memories.consolidation_type',
        "ALTER TABLE memories ADD COLUMN consolidation_type TEXT DEFAULT 'standard'");

    // v54: draco_inner_log.is_processed — Auto-Historian 批处理标记
    runMigration(54, 'draco_inner_log.is_processed',
        "ALTER TABLE draco_inner_log ADD COLUMN is_processed INTEGER DEFAULT 0");

    // v55: entity_profiles.aliases + memory_fragments.entity_id — 实体结构化关联
    runMigration(55, 'entity aliases + fragment entity_id FK',
        `ALTER TABLE entity_profiles ADD COLUMN aliases TEXT DEFAULT '[]';
         ALTER TABLE memory_fragments ADD COLUMN entity_id INTEGER;`);

    // v56: alarms — StackChan 闹钟调度
    runMigration(56, 'alarms table',
        `CREATE TABLE IF NOT EXISTS alarms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            trigger_at INTEGER NOT NULL,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending','firing','fired','missed','cancelled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            fired_at DATETIME
        )`);

    // v57-v58: SnitchBot 调度健壮性
    runMigration(57, 'newsapi_rate_log',
        `CREATE TABLE IF NOT EXISTS newsapi_rate_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT,
            called_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    runMigration(57, 'idx_newsapi_rate_log_called_at',
        'CREATE INDEX IF NOT EXISTS idx_newsapi_rate_log_called_at ON newsapi_rate_log(called_at)');

    runMigration(58, 'snitch_bot_state',
        `CREATE TABLE IF NOT EXISTS snitch_bot_state (
            bot_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (bot_id, key)
        )`);

    // ── 记忆系统升级：本体论索引 ──
    runMigration(59, 'memory_ontology table',
        `CREATE TABLE IF NOT EXISTS memory_ontology (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            parent_id INTEGER,
            description TEXT,
            centroid_embedding TEXT,
            fragment_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (parent_id) REFERENCES memory_ontology(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ontology_parent ON memory_ontology(parent_id);
        CREATE INDEX IF NOT EXISTS idx_ontology_path ON memory_ontology(path);`);

    runMigration(60, 'fragment_categories table',
        `CREATE TABLE IF NOT EXISTS fragment_categories (
            fragment_id INTEGER NOT NULL,
            category_id INTEGER NOT NULL,
            confidence REAL DEFAULT 0.5,
            classified_by TEXT DEFAULT 'archivist',
            classified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (fragment_id, category_id),
            FOREIGN KEY (fragment_id) REFERENCES memory_fragments(id),
            FOREIGN KEY (category_id) REFERENCES memory_ontology(id)
        );
        CREATE INDEX IF NOT EXISTS idx_fc_category ON fragment_categories(category_id);
        CREATE INDEX IF NOT EXISTS idx_fc_fragment ON fragment_categories(fragment_id);`);

    runMigration(61, 'ontology_changelog table',
        `CREATE TABLE IF NOT EXISTS ontology_changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            category_id INTEGER,
            category_path TEXT,
            detail TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES memory_ontology(id)
        );
        CREATE INDEX IF NOT EXISTS idx_oc_created ON ontology_changelog(created_at);`);

    runMigration(62, 'ontology_changelog confidence/status columns',
        `ALTER TABLE ontology_changelog ADD COLUMN confidence REAL;
         ALTER TABLE ontology_changelog ADD COLUMN status TEXT DEFAULT 'pending';
         CREATE INDEX IF NOT EXISTS idx_oc_status ON ontology_changelog(status);`);

    runMigration(63, 'entity relationship fields + fragment insight + 人物 root',
        `ALTER TABLE entity_profiles ADD COLUMN relationship_to_clara TEXT;
         ALTER TABLE entity_profiles ADD COLUMN relationship_nature TEXT;
         ALTER TABLE entity_profiles ADD COLUMN emotional_significance TEXT;
         ALTER TABLE entity_profiles ADD COLUMN first_mentioned_date TEXT;
         ALTER TABLE entity_profiles ADD COLUMN last_mentioned_date TEXT;
         ALTER TABLE memory_fragments ADD COLUMN insight TEXT;
         INSERT OR IGNORE INTO memory_ontology (path, label, parent_id, description)
         VALUES ('人物', '人物', NULL, 'Clara 生活里的人——每个人都是理解她的一个窗口');`);

    // v64: 认知进化层 — 自纠错记忆 + 融合规则
    runMigration(64, 'cognitive evolution layer: correction log + cognitive rules',
        `CREATE TABLE IF NOT EXISTS cognitive_corrections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id INTEGER NOT NULL,
            entity_name TEXT NOT NULL,
            wrong_label TEXT NOT NULL,
            correct_label TEXT NOT NULL,
            mispattern TEXT,
            evidence_summary TEXT,
            fragment_count_at_eval INTEGER,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','fused')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (entity_id) REFERENCES entity_profiles(id)
        );
        CREATE INDEX IF NOT EXISTS idx_cc_entity ON cognitive_corrections(entity_id);
        CREATE INDEX IF NOT EXISTS idx_cc_wrong_label ON cognitive_corrections(wrong_label);
        CREATE INDEX IF NOT EXISTS idx_cc_status ON cognitive_corrections(status);

        CREATE TABLE IF NOT EXISTS cognitive_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_text TEXT NOT NULL,
            wrong_label TEXT NOT NULL,
            correct_label_pattern TEXT,
            fused_from_correction_ids TEXT DEFAULT '[]',
            fusion_count INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','retired')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cr_wrong_label ON cognitive_rules(wrong_label);
        CREATE INDEX IF NOT EXISTS idx_cr_status ON cognitive_rules(status);

        ALTER TABLE entity_profiles ADD COLUMN last_evaluated_at TEXT;
        ALTER TABLE entity_profiles ADD COLUMN relationship_confidence TEXT DEFAULT NULL;`);

    // v65: Archivist Agent — skill system table
    runMigration(65, 'archivist agent: archivist_skills table',
        `CREATE TABLE IF NOT EXISTS archivist_skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('hypothesis','monitor','lesson')),
            trigger_config TEXT NOT NULL,
            analysis_config TEXT NOT NULL,
            observations TEXT DEFAULT '[]',
            confidence REAL DEFAULT 0.3,
            entity_ids TEXT DEFAULT '[]',
            source_pattern TEXT,
            self_evaluation TEXT,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','verified','falsified','merged')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_evaluated_at DATETIME,
            last_triggered_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_as_type ON archivist_skills(type);
        CREATE INDEX IF NOT EXISTS idx_as_status ON archivist_skills(status);`);

    runMigration(66, 'memory_fragments.source_memory_id + confidence',
        `ALTER TABLE memory_fragments ADD COLUMN source_memory_id INTEGER;
         ALTER TABLE memory_fragments ADD COLUMN confidence REAL DEFAULT 0.5;`);

    runMigration(67, 'entity_profiles progressive re-eval fields',
        `ALTER TABLE entity_profiles ADD COLUMN last_hypothesis TEXT;
         ALTER TABLE entity_profiles ADD COLUMN last_eval_frag_count INTEGER DEFAULT 0;`);

    runMigration(68, 'entity_profiles.overview — Draco-perspective narrative',
        `ALTER TABLE entity_profiles ADD COLUMN overview TEXT;
         ALTER TABLE entity_profiles ADD COLUMN overview_updated_at DATETIME;`);

    runMigration(69, 'entity_profiles.entity_type — real person vs fictional vs public figure',
        `ALTER TABLE entity_profiles ADD COLUMN entity_type TEXT DEFAULT NULL;`);

    runMigration(70, 'flatten memory_ontology — remove person nodes, drop hierarchy',
        `-- Step 1: Null out changelog refs to person/public_figure/fictional nodes
         UPDATE ontology_changelog SET category_id = NULL WHERE category_id IN (
             SELECT id FROM memory_ontology
             WHERE path LIKE '人物%' OR path LIKE '公众人物%' OR path LIKE '虚构角色%'
         );
         -- Step 2: Release fragment_categories refs to person nodes (incl. root '人物', '公众人物')
         DELETE FROM fragment_categories WHERE category_id IN (
             SELECT id FROM memory_ontology
             WHERE path LIKE '人物%' OR path LIKE '公众人物%' OR path LIKE '虚构角色%'
         );
         -- Step 3: Detach children of person nodes (self-referencing FK on parent_id)
         UPDATE memory_ontology SET parent_id = NULL WHERE parent_id IN (
             SELECT id FROM memory_ontology
             WHERE path LIKE '人物%' OR path LIKE '公众人物%' OR path LIKE '虚构角色%'
         );
         -- Step 4: Delete person+public_figure+fictional category nodes (roots + children)
         DELETE FROM memory_ontology
             WHERE path LIKE '人物%' OR path LIKE '公众人物%' OR path LIKE '虚构角色%';
         -- Step 5: Flatten all remaining nodes
         UPDATE memory_ontology SET parent_id = NULL;`);

    runMigration(71, 'clara_model — unified four-layer memory model',
        `CREATE TABLE IF NOT EXISTS clara_model (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('immutable_fact','stable_trait','current_state','active_hypothesis')),
            content TEXT NOT NULL,
            confidence REAL DEFAULT 0.3,
            decay_type TEXT DEFAULT NULL CHECK(decay_type IN ('none','evidence_dependent','exponential','linear')),
            decay_params TEXT DEFAULT '{}',
            evidence_count INTEGER DEFAULT 0,
            last_evidence_at TEXT,
            last_contradiction_at TEXT,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','resolved','abandoned','superseded','corrected')),
            resolved_at TEXT,
            resolve_reason TEXT,
            evolution_history TEXT DEFAULT '[]',
            superseded_by INTEGER DEFAULT NULL REFERENCES clara_model(id),
            contradicts_id INTEGER DEFAULT NULL REFERENCES clara_model(id),
            source_fragment_ids TEXT DEFAULT '[]',
            entity_ids TEXT DEFAULT '[]',
            parent_skill_id INTEGER DEFAULT NULL,
            migration_source TEXT DEFAULT NULL,
            tags TEXT DEFAULT '[]',
            priority INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cm_type ON clara_model(type);
        CREATE INDEX IF NOT EXISTS idx_cm_status ON clara_model(status);
        CREATE INDEX IF NOT EXISTS idx_cm_last_evidence ON clara_model(last_evidence_at);
        CREATE INDEX IF NOT EXISTS idx_cm_parent_skill ON clara_model(parent_skill_id);`);

    // ── v73-v76: v4.7 实体星系 — 知识树退役、苗圃机制、边标签、溯源链路 ──
    runMigration(73, 'v4.7: fragment_entities junction table', `
        CREATE TABLE IF NOT EXISTS fragment_entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id),
            entity_id INTEGER NOT NULL REFERENCES entity_profiles(id),
            relation TEXT,
            confidence REAL DEFAULT 0.70,
            classified_by TEXT DEFAULT 'draco_flash',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(fragment_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_fe_fragment ON fragment_entities(fragment_id);
        CREATE INDEX IF NOT EXISTS idx_fe_entity ON fragment_entities(entity_id);`);

    runMigration(74, 'v4.7: entity_timeline table', `
        CREATE TABLE IF NOT EXISTS entity_timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id INTEGER NOT NULL REFERENCES entity_profiles(id),
            fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id),
            action TEXT NOT NULL,
            detail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_et_entity ON entity_timeline(entity_id);
        CREATE INDEX IF NOT EXISTS idx_et_created ON entity_timeline(created_at);`);

    runMigration(75, 'v4.7: entity_profiles status/related_entities/fragment_count', `
        ALTER TABLE entity_profiles ADD COLUMN status TEXT DEFAULT 'active';
        ALTER TABLE entity_profiles ADD COLUMN related_entities TEXT DEFAULT '[]';
        ALTER TABLE entity_profiles ADD COLUMN fragment_count INTEGER DEFAULT 0;`);

    runMigration(76, 'v4.7: memory_fragments.access_count',
        `ALTER TABLE memory_fragments ADD COLUMN access_count INTEGER DEFAULT 0;`);

    runMigration(77, 'v4.7: entity_profiles.subcategory',
        `ALTER TABLE entity_profiles ADD COLUMN subcategory TEXT;`);

    // entity_timeline.fragment_id: allow NULL for system actions (graduate, dormancy, etc.)
    runMigration(78, 'v4.7: entity_timeline.fragment_id nullable', `
        CREATE TABLE IF NOT EXISTS entity_timeline_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id INTEGER NOT NULL REFERENCES entity_profiles(id),
            fragment_id INTEGER REFERENCES memory_fragments(id),
            action TEXT NOT NULL,
            detail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO entity_timeline_new SELECT * FROM entity_timeline;
        DROP TABLE entity_timeline;
        ALTER TABLE entity_timeline_new RENAME TO entity_timeline;
        CREATE INDEX IF NOT EXISTS idx_et_entity ON entity_timeline(entity_id);
        CREATE INDEX IF NOT EXISTS idx_et_created ON entity_timeline(created_at);`);

    // 回填 entity_profiles.fragment_count
    try {
        const needsBackfill = db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE fragment_count = 0 AND source_fragment_ids IS NOT NULL AND source_fragment_ids != '[]'").get();
        if (needsBackfill && needsBackfill.c > 0) {
            const rows = db.prepare("SELECT id, source_fragment_ids FROM entity_profiles WHERE source_fragment_ids IS NOT NULL AND source_fragment_ids != '[]'").all();
            const update = db.prepare('UPDATE entity_profiles SET fragment_count = ? WHERE id = ?');
            const backfillBatch = db.transaction(() => {
                let total = 0;
                for (const r of rows) {
                    try {
                        const ids = JSON.parse(r.source_fragment_ids);
                        if (Array.isArray(ids) && ids.length > 0) {
                            update.run(ids.length, r.id);
                            total++;
                        }
                    } catch (e) { /* skip malformed JSON */ }
                }
                return total;
            });
            const count = backfillBatch();
            if (count > 0) console.log(`[DB] v76 回填 ${count} 条 entity_profiles.fragment_count`);
        }
    } catch (e) {
        console.error('[DB] v76 fragment_count 回填失败:', e.message);
    }

    // 回填 fragment_entities: 从 memory_fragments.entity_id 迁移
    try {
        const needsFeBackfill = db.prepare('SELECT COUNT(*) as c FROM fragment_entities').get();
        if (needsFeBackfill && needsFeBackfill.c === 0) {
            const frags = db.prepare("SELECT id, entity_id FROM memory_fragments WHERE entity_id IS NOT NULL AND entity_id > 0 AND status = 'active'").all();
            if (frags.length > 0) {
                const insert = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, classified_by) VALUES (?, ?, ?)');
                const feBatch = db.transaction(() => {
                    let count = 0;
                    for (const f of frags) {
                        const result = insert.run(f.id, f.entity_id, 'backfill_v76');
                        if (result.changes > 0) count++;
                    }
                    return count;
                });
                const c = feBatch();
                if (c > 0) console.log(`[DB] v76 回填 ${c} 条 fragment_entities (from memory_fragments.entity_id)`);
            }
        }
    } catch (e) {
        console.error('[DB] v76 fragment_entities 回填失败:', e.message);
    }

    runMigration(72, 'clara_model — source_quality + source_diversity for evidence pipeline',
        `ALTER TABLE clara_model ADD COLUMN source_quality TEXT DEFAULT 'inferred' CHECK(source_quality IN ('direct_statement','inferred','backfilled'));
         ALTER TABLE clara_model ADD COLUMN source_diversity INTEGER DEFAULT 1;
         -- Backfill existing entries: seeded from entity_profiles with high confidence = direct_statement
         UPDATE clara_model SET source_quality = 'direct_statement' WHERE type = 'immutable_fact' AND migration_source LIKE '%entity_profiles%';
         -- seeded from skills/hypothesis detection = inferred
         UPDATE clara_model SET source_quality = 'inferred' WHERE migration_source LIKE '%detectNewTraits%' OR migration_source LIKE '%archivist_skills%';
         UPDATE clara_model SET source_quality = 'backfilled' WHERE migration_source IS NULL OR migration_source = '';`);

    runMigration(79, 'v4.8: memories.audit_status for episode quality audit',
        `ALTER TABLE memories ADD COLUMN audit_status TEXT DEFAULT NULL;`);

    // v80-v81: Clara Model — Draco active state management + TTL overhaul
    runMigration(80, 'v5.0: clara_model.created_by for source attribution',
        `ALTER TABLE clara_model ADD COLUMN created_by TEXT DEFAULT 'deep_cycle';`);

    runMigration(81, 'v5.0: clara_model.expires_at for explicit TTL timestamps',
        `ALTER TABLE clara_model ADD COLUMN expires_at TEXT DEFAULT NULL;
         -- Backfill expires_at for active current_state entries based on TTL rules
         UPDATE clara_model SET created_by = 'deep_cycle' WHERE created_by IS NULL;
         -- ID 210: emotional/until_event → created_at + 30 days
         UPDATE clara_model SET expires_at = datetime(created_at, '+30 days')
           WHERE id = 210 AND type = 'current_state' AND expires_at IS NULL;
         -- ID 232: relational/days (was bug: days key missing in TTL_MAP) → +72h
         UPDATE clara_model SET expires_at = datetime(created_at, '+72 hours')
           WHERE id = 232 AND type = 'current_state' AND expires_at IS NULL;
         -- ID 205: situational/until_event → created_at + 30 days
         UPDATE clara_model SET expires_at = datetime(created_at, '+30 days')
           WHERE id = 205 AND type = 'current_state' AND expires_at IS NULL;`);

    runMigration(82, 'v5.1: entity_profiles.tags for constellation tags/aliases',
        `ALTER TABLE entity_profiles ADD COLUMN tags TEXT DEFAULT '[]';`);

    runMigration(83, 'v5.2: clara_patterns — accumulated behavioral observations',
        `CREATE TABLE IF NOT EXISTS clara_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            category TEXT DEFAULT 'behavior' CHECK(category IN ('behavior','preference','emotional','social','other')),
            evidence_count INTEGER DEFAULT 0,
            first_seen TEXT,
            last_seen TEXT,
            confidence REAL DEFAULT 0.25,
            source_fragment_ids TEXT DEFAULT '[]',
            tags TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active' CHECK(status IN ('active','merged','superseded')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );`);

    // 种子数据：初始本体论类别（仅当表为空时插入）
    try {
        const existingRoots = db.prepare('SELECT COUNT(*) as c FROM memory_ontology WHERE parent_id IS NULL').get();
        if (existingRoots.c === 0) {
            const seed = db.prepare('INSERT INTO memory_ontology (path, label, parent_id, description) VALUES (?, ?, ?, ?)');
            const seedBatch = db.transaction(() => {
                // Root categories
                const roots = [
                    ['人际关系', '人际关系', null, 'Clara与他人的关系记忆'],
                    ['地点', '地点', null, '与具体地点相关的记忆'],
                    ['创作', '创作', null, 'Clara的写作与创作记忆'],
                    ['日常', '日常', null, '日常生活与日记'],
                    ['音乐', '音乐', null, '音乐相关记忆'],
                    ['工作', '工作', null, '配音与工作相关记忆'],
                    ['健康', '健康', null, '健康与身体状态'],
                ];
                for (const [p, l, pid, d] of roots) {
                    seed.run(p, l, pid, d);
                }
                // Child categories: parent_id derived from insertion order (1=人际关系, 2=地点, 3=创作)
                const children = [
                    ['人际关系/朋友', '朋友', 1, 'Clara的朋友圈'],
                    ['人际关系/家人', '家人', 1, 'Clara的家人'],
                    ['人际关系/关于我们', '关于我们', 1, 'Draco与Clara的关系记忆'],
                    ['地点/上海', '上海', 2, '上海相关地点'],
                    ['地点/旅行', '旅行', 2, '旅行记忆'],
                    ['创作/写作', '写作', 3, '小说与写作'],
                    ['创作/配音', '配音', 3, '配音作品与录音'],
                    ['创作/绘画', '绘画', 3, 'spine动画与绘画'],
                ];
                // Re-query root IDs for reliable FK references
                for (const [p, l, pid, d] of children) {
                    seed.run(p, l, pid, d);
                }
            });
            seedBatch();
            console.log('[DB] 本体论种子数据已插入');
        }
    } catch (e) {
        console.error('[DB] 本体论种子数据插入失败（表已存在则忽略）:', e.message);
    }

    // ── 打印当前 schema 版本 ──
    const currentVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    console.log(`[DB] 数据库初始化完成, schema v${currentVersion.v || 0}`);

    _initialized = true;
    return db;
}

function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

module.exports = { initDatabase, getDb };
