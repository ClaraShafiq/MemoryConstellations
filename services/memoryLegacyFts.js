'use strict';

const TRIGGERS = [
    'mf_fts_insert', 'mf_fts_update', 'mf_fts_delete',
    'memories_fts_insert', 'memories_fts_update', 'memories_fts_delete',
];

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

function splitCJK(text) {
    return text ? String(text).replace(CJK_RE, ' $& ') : '';
}

function exists(db, type, name) {
    return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name);
}

function inspect(db, { deep = false } = {}) {
    const issues = [];
    for (const table of ['memory_fragments_fts', 'memories_fts',
        'memory_fragments_fts_docsize', 'memories_fts_docsize']) {
        if (!exists(db, 'table', table)) issues.push(`fts_table_missing:${table}`);
    }
    const presentTriggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
        AND name IN (${TRIGGERS.map(() => '?').join(',')})`).all(...TRIGGERS).map(row => row.name);
    for (const name of TRIGGERS) if (!presentTriggers.includes(name)) issues.push(`fts_trigger_missing:${name}`);

    let counts = null;
    if (!issues.some(issue => issue.startsWith('fts_table_missing:'))) {
        counts = {
            fragments_expected: db.prepare("SELECT COUNT(*) count FROM memory_fragments WHERE status='active'").get().count,
            fragments_indexed: db.prepare('SELECT COUNT(*) count FROM memory_fragments_fts_docsize').get().count,
            memories_expected: db.prepare('SELECT COUNT(*) count FROM memories').get().count,
            memories_indexed: db.prepare('SELECT COUNT(*) count FROM memories_fts_docsize').get().count,
        };
        if (counts.fragments_expected !== counts.fragments_indexed) issues.push('fts_fragment_count_mismatch');
        if (counts.memories_expected !== counts.memories_indexed) issues.push('fts_memory_count_mismatch');
        if (deep) {
            try {
                db.prepare("INSERT INTO memory_fragments_fts(memory_fragments_fts,rank) VALUES('integrity-check',1)").run();
            } catch (_) { issues.push('fts_fragment_integrity_failed'); }
            try {
                db.prepare("INSERT INTO memories_fts(memories_fts,rank) VALUES('integrity-check',1)").run();
            } catch (_) { issues.push('fts_memory_integrity_failed'); }
        }
    }
    return { status: issues.length ? 'drift' : 'healthy', coverage: deep ? 'content' : 'structural',
        issues, counts, triggers: { expected: TRIGGERS.length, actual: presentTriggers.length } };
}

function triggerSql() {
    return `
        DROP TRIGGER IF EXISTS mf_fts_insert;
        DROP TRIGGER IF EXISTS mf_fts_update;
        DROP TRIGGER IF EXISTS mf_fts_delete;
        DROP TRIGGER IF EXISTS memories_fts_insert;
        DROP TRIGGER IF EXISTS memories_fts_update;
        DROP TRIGGER IF EXISTS memories_fts_delete;
        CREATE TRIGGER mf_fts_insert AFTER INSERT ON memory_fragments
            WHEN new.status='active' BEGIN
                INSERT INTO memory_fragments_fts(rowid,content,entity)
                VALUES(new.id,splitCJK(new.content),splitCJK(COALESCE(new.entity,'')));
            END;
        CREATE TRIGGER mf_fts_update AFTER UPDATE ON memory_fragments BEGIN
                INSERT INTO memory_fragments_fts(memory_fragments_fts,rowid,content,entity)
                SELECT 'delete',old.id,splitCJK(old.content),splitCJK(COALESCE(old.entity,''))
                WHERE old.status='active';
                INSERT INTO memory_fragments_fts(rowid,content,entity)
                SELECT new.id,splitCJK(new.content),splitCJK(COALESCE(new.entity,''))
                WHERE new.status='active';
            END;
        CREATE TRIGGER mf_fts_delete AFTER DELETE ON memory_fragments
            WHEN old.status='active' BEGIN
                INSERT INTO memory_fragments_fts(memory_fragments_fts,rowid,content,entity)
                VALUES('delete',old.id,splitCJK(old.content),splitCJK(COALESCE(old.entity,'')));
            END;
        CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid,title,tags_text)
                VALUES(new.id,COALESCE(new.title,''),
                    COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags,'["',''),'\"]',''),'","',' '),'"',''),''));
            END;
        CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
                UPDATE memories_fts SET title=COALESCE(new.title,''),
                    tags_text=COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(new.tags,'["',''),'\"]',''),'","',' '),'"',''),'')
                WHERE rowid=new.id;
            END;
        CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
                DELETE FROM memories_fts WHERE rowid=old.id;
            END;
    `;
}

function schemaSql() {
    return `
        ${TRIGGERS.map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
        DROP TABLE IF EXISTS memory_fragments_fts;
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memory_fragments_fts
            USING fts5(content, entity, content='memory_fragments', content_rowid='id');
        CREATE VIRTUAL TABLE memories_fts USING fts5(title, tags_text);
        ${triggerSql()}
    `;
}

function rebuild(db) {
    const result = db.transaction(() => {
        db.exec(schemaSql());
        const fragments = db.prepare("SELECT id,content,COALESCE(entity,'') entity FROM memory_fragments WHERE status='active'").all();
        const insertFragment = db.prepare('INSERT INTO memory_fragments_fts(rowid,content,entity) VALUES(?,?,?)');
        for (const row of fragments) insertFragment.run(row.id, splitCJK(row.content), splitCJK(row.entity));
        const memories = db.prepare("SELECT id,COALESCE(title,'') title,COALESCE(tags,'') tags FROM memories").all();
        const insertMemory = db.prepare('INSERT INTO memories_fts(rowid,title,tags_text) VALUES(?,?,?)');
        for (const row of memories) {
            const tags = row.tags.replace(/\["/g, '').replace(/"\]/g, '').replace(/","/g, ' ').replace(/"/g, '');
            insertMemory.run(row.id, row.title, tags);
        }
        return { fragments: fragments.length, memories: memories.length };
    })();
    return { ...result, health: inspect(db, { deep: true }) };
}

module.exports = { TRIGGERS, splitCJK, inspect, rebuild, schemaSql, triggerSql };
