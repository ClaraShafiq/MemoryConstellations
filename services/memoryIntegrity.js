// Source provenance and withdrawal are database contracts, shared by all producers.
const { createHash } = require('node:crypto');
const KINDS = new Set(['user_fact', 'interaction_pattern', 'ai_opinion', 'fiction', 'third_party', 'unverified']);
const TYPES = new Set(['profile', 'episode', 'user_model', 'pattern', 'saga']);
const identifier = value => {
    if (!/^[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?$/i.test(value)) throw Error('Invalid SQL identifier');
    return value;
};
function gate(type, expression) {
    if (!TYPES.has(type)) throw Error('Invalid review type');
    return `NOT EXISTS(SELECT 1 FROM memory_derivation_reviews r WHERE r.target_type='${type}' AND r.target_id=${identifier(expression)})`;
}
function enqueue(type, select, reason) {
    return `INSERT INTO memory_derivation_reviews(target_type,target_id,reason)
        SELECT '${type}',id,'${reason}' FROM (${select}) WHERE id IS NOT NULL
        ON CONFLICT(target_type,target_id) DO UPDATE SET revision=revision+1,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP;`;
}
function dependents(fragment, reason) {
    const episodes = `SELECT memory_id AS id FROM episode_fragment_sources WHERE fragment_id=${fragment}`;
    return enqueue('profile', `SELECT entity_id AS id FROM fragment_entities WHERE fragment_id=${fragment}`, reason)
        + enqueue('episode', episodes, reason)
        + enqueue('user_model', `SELECT id FROM user_model WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(source_fragment_ids) THEN source_fragment_ids ELSE '[]' END) j WHERE j.value=${fragment})`, reason)
        + enqueue('pattern', `SELECT id FROM user_patterns WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(source_fragment_ids) THEN source_fragment_ids ELSE '[]' END) j WHERE j.value=${fragment})`, reason)
        + enqueue('saga', `SELECT id FROM memory_sagas WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(memory_ids) THEN memory_ids ELSE '[]' END) j WHERE j.value IN (${episodes}))`, reason);
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_fragment_provenance(
 fragment_id INTEGER PRIMARY KEY REFERENCES memory_fragments(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('user_fact','interaction_pattern','ai_opinion','fiction','third_party','unverified')),
 state TEXT NOT NULL CHECK(state IN ('quoted','pending','stale')),
 evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
 input_msg_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(input_msg_ids)),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memory_derivation_reviews(
 target_type TEXT NOT NULL CHECK(target_type IN ('profile','episode','user_model','pattern','saga')),
 target_id INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(target_type,target_id));
CREATE TABLE IF NOT EXISTS episode_fragment_sources(
 memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
 fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
 fully_covered INTEGER NOT NULL DEFAULT 0 CHECK(fully_covered IN(0,1)),PRIMARY KEY(memory_id,fragment_id));
CREATE INDEX IF NOT EXISTS idx_episode_fragment_sources_fragment ON episode_fragment_sources(fragment_id);
CREATE TABLE IF NOT EXISTS memory_profile_history(id INTEGER PRIMARY KEY,entity_id INTEGER NOT NULL,
 facts TEXT,current_status TEXT,judgment TEXT,saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_model_evidence_checks(entry_id INTEGER NOT NULL,fragment_id INTEGER NOT NULL,
 snapshot TEXT NOT NULL,supports INTEGER NOT NULL CHECK(supports IN(0,1)),quote TEXT NOT NULL,
 checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(entry_id,fragment_id));
CREATE TRIGGER IF NOT EXISTS memory_link_changed AFTER UPDATE OF relation,confidence,classified_by,entity_id ON fragment_entities
WHEN OLD.relation IS NOT NEW.relation OR OLD.confidence IS NOT NEW.confidence OR OLD.classified_by IS NOT NEW.classified_by OR OLD.entity_id IS NOT NEW.entity_id
BEGIN ${enqueue('profile','SELECT OLD.entity_id AS id','attribution_changed')}${dependents('OLD.fragment_id','attribution_changed')} END;
CREATE TRIGGER IF NOT EXISTS memory_link_removed AFTER DELETE ON fragment_entities
BEGIN ${enqueue('profile','SELECT OLD.entity_id AS id','attribution_removed')}${dependents('OLD.fragment_id','attribution_removed')} END;
CREATE TRIGGER IF NOT EXISTS memory_fragment_changed AFTER UPDATE OF content,source_date,source_msg_ids ON memory_fragments
WHEN OLD.content IS NOT NEW.content OR OLD.source_date IS NOT NEW.source_date OR OLD.source_msg_ids IS NOT NEW.source_msg_ids
BEGIN UPDATE memory_fragment_provenance SET state='stale',updated_at=CURRENT_TIMESTAMP WHERE fragment_id=NEW.id;
${dependents('NEW.id','fragment_changed')} END;
CREATE TRIGGER IF NOT EXISTS memory_fragment_removed BEFORE DELETE ON memory_fragments
BEGIN ${dependents('OLD.id','fragment_removed')} END;
CREATE TRIGGER IF NOT EXISTS memory_provenance_stale AFTER UPDATE OF kind,state,evidence_json ON memory_fragment_provenance
WHEN OLD.kind IS NOT NEW.kind OR OLD.state IS NOT NEW.state OR OLD.evidence_json IS NOT NEW.evidence_json
BEGIN ${dependents('NEW.fragment_id','source_changed')} END;
CREATE TRIGGER IF NOT EXISTS memory_provenance_pending_insert AFTER INSERT ON memory_fragment_provenance
WHEN NEW.state='stale' BEGIN ${dependents('NEW.fragment_id','legacy_source_changed')} END;
CREATE TRIGGER IF NOT EXISTS memory_source_changed AFTER UPDATE OF content,sender,chat_id,chat_mode,is_rp,timestamp,status ON messages
WHEN OLD.content IS NOT NEW.content OR OLD.sender IS NOT NEW.sender OR OLD.chat_id IS NOT NEW.chat_id OR OLD.chat_mode IS NOT NEW.chat_mode OR OLD.is_rp IS NOT NEW.is_rp OR OLD.timestamp IS NOT NEW.timestamp OR OLD.status IS NOT NEW.status
BEGIN UPDATE memory_fragment_provenance SET state='stale',updated_at=CURRENT_TIMESTAMP
 WHERE EXISTS(SELECT 1 FROM json_each(evidence_json) j WHERE json_extract(j.value,'$.message_id')=NEW.id);
 INSERT INTO memory_fragment_provenance(fragment_id,kind,state,input_msg_ids)
 SELECT id,'unverified','stale',source_msg_ids FROM memory_fragments f
 WHERE json_valid(source_msg_ids) AND EXISTS(SELECT 1 FROM json_each(source_msg_ids) j WHERE j.value=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM memory_fragment_provenance p WHERE p.fragment_id=f.id); END;
CREATE TRIGGER IF NOT EXISTS memory_source_removed AFTER DELETE ON messages
BEGIN UPDATE memory_fragment_provenance SET state='stale',updated_at=CURRENT_TIMESTAMP
 WHERE EXISTS(SELECT 1 FROM json_each(evidence_json) j WHERE json_extract(j.value,'$.message_id')=OLD.id);
 INSERT INTO memory_fragment_provenance(fragment_id,kind,state,input_msg_ids)
 SELECT id,'unverified','stale',source_msg_ids FROM memory_fragments f
 WHERE json_valid(source_msg_ids) AND EXISTS(SELECT 1 FROM json_each(source_msg_ids) j WHERE j.value=OLD.id)
 AND NOT EXISTS(SELECT 1 FROM memory_fragment_provenance p WHERE p.fragment_id=f.id); END;
CREATE TRIGGER IF NOT EXISTS memory_episode_changed AFTER UPDATE OF content,entity_id,source_msg_ids ON memories
WHEN OLD.content IS NOT NEW.content OR OLD.entity_id IS NOT NEW.entity_id OR OLD.source_msg_ids IS NOT NEW.source_msg_ids
BEGIN ${enqueue('profile','SELECT OLD.entity_id AS id UNION SELECT NEW.entity_id AS id','episode_changed')}
${enqueue('saga',"SELECT id FROM memory_sagas WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(memory_ids) THEN memory_ids ELSE '[]' END) j WHERE j.value=NEW.id)",'episode_changed')} END;
CREATE TRIGGER IF NOT EXISTS memory_episode_removed BEFORE DELETE ON memories
BEGIN ${enqueue('profile','SELECT OLD.entity_id AS id','episode_removed')}
${enqueue('saga',"SELECT id FROM memory_sagas WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(memory_ids) THEN memory_ids ELSE '[]' END) j WHERE j.value=OLD.id)",'episode_removed')} END;
CREATE TRIGGER IF NOT EXISTS memory_profile_history_save BEFORE UPDATE OF facts,current_status,judgment ON entity_profiles
WHEN OLD.facts IS NOT NEW.facts OR OLD.current_status IS NOT NEW.current_status OR OLD.judgment IS NOT NEW.judgment
BEGIN INSERT INTO memory_profile_history(entity_id,facts,current_status,judgment,reason)
 VALUES(OLD.id,OLD.facts,OLD.current_status,OLD.judgment,'profile_updated'); END;`;
function fingerprint(message) {
    return createHash('sha256').update(JSON.stringify([message.content,message.sender,message.chat_id,message.chat_mode,message.is_rp,message.timestamp,message.status])).digest('hex');
}
function prepareSource(entry, messages, mainIds) {
    const rows = new Map(messages.map(m => [m.id,m]));
    let valid = Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.length <= 12;
    let kind = KINDS.has(entry.memory_kind) ? entry.memory_kind : 'unverified';
    const evidence = [];
    for (const e of (Array.isArray(entry.evidence) ? entry.evidence.slice(0,12) : [])) {
        const m = rows.get(e?.message_id), quote = typeof e?.quote === 'string' ? e.quote.trim() : '';
        if (!m || m.status === 'draft' || quote.length < 2 || !m.text?.includes(quote)) { valid=false; continue; }
        evidence.push({message_id:m.id,quote,sender:m.sender,chat_id:m.chat_id,timestamp:m.timestamp,
            mode:m.is_rp ? 'roleplay' : (m.chat_mode || 'default'),fingerprint:fingerprint(m)});
    }
    if (!evidence.some(e => mainIds.has(e.message_id)) || new Set(evidence.map(e=>e.chat_id)).size!==1
        || new Set(evidence.map(e=>e.mode)).size!==1) valid=false;
    if (kind==='user_fact' && evidence.some(e=>e.sender!=='user')) valid=false;
    if (kind==='ai_opinion' && !evidence.some(e=>e.sender==='ai')) valid=false;
    if (valid && evidence.some(e=>['roleplay','game','cinema'].includes(e.mode))) kind='fiction';
    if (!valid) kind='unverified';
    return {kind,state:valid && kind!=='unverified' ? 'quoted':'pending',evidence,
        msgIds:valid ? [...new Set(evidence.map(e=>e.message_id))].sort((a,b)=>a-b) : [],
        mode:valid ? evidence[0].mode : 'default',
        date:valid ? evidence.map(e=>e.timestamp).filter(t=>/^\d{4}-\d{2}-\d{2}/.test(t||'')).sort().at(-1)?.slice(0,10) || null : null};
}
function persistSource(db,id,source,window) {
    for (const e of source.evidence) {
        const fresh=db.prepare('SELECT * FROM messages WHERE id=?').get(e.message_id);
        if (!fresh || fingerprint(fresh)!==e.fingerprint) throw Error('Source changed during extraction');
    }
    db.prepare('INSERT INTO memory_fragment_provenance(fragment_id,kind,state,evidence_json,input_msg_ids) VALUES(?,?,?,?,?)')
        .run(id,source.kind,source.state,JSON.stringify(source.evidence),JSON.stringify(window));
}
function sourceFor(db,id) { return db.prepare('SELECT * FROM memory_fragment_provenance WHERE fragment_id=?').get(id); }
function revision(db,type,id) { return db.prepare('SELECT revision FROM memory_derivation_reviews WHERE target_type=? AND target_id=?').get(type,id)?.revision || 0; }
function commitReview(db,type,id,version,write) {
    return db.transaction(()=>{
        if (revision(db,type,id)!==version) return false;
        write();
        if (version) db.prepare('DELETE FROM memory_derivation_reviews WHERE target_type=? AND target_id=? AND revision=?').run(type,id,version);
        return true;
    })();
}
function describe(text,kind,state='quoted') {
    const labels={user_fact:'用户自述，保留时间和范围',interaction_pattern:'与AI互动的表达，不泛化为人格',ai_opinion:'AI的理解，不是用户自述',fiction:'创作或扮演，不是现实经历',third_party:'第三方材料，不是用户自身事实',unverified:'来源尚未核验'};
    return `【${state==='quoted' ? labels[kind] || labels.unverified : '来源已变化或待核实，不作为确定事实'}】\n${text}`;
}
module.exports={SCHEMA,KINDS,TYPES,gate,enqueue,dependents,fingerprint,prepareSource,persistSource,sourceFor,revision,commitReview,describe};
