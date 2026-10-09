// Operational contracts contain counts and error codes, never message text or secrets.
const OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_review_actions(id INTEGER PRIMARY KEY,target_type TEXT NOT NULL,target_id INTEGER NOT NULL,
 revision INTEGER NOT NULL,action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memory_pipeline_runs(stage TEXT PRIMARY KEY,last_started_at TEXT,last_success_at TEXT,
 last_failure_at TEXT,last_error_code TEXT,success_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0);`;
const REQUIRED_TRIGGERS=['memory_link_changed','memory_link_removed','memory_fragment_changed','memory_fragment_removed',
    'memory_source_changed','memory_source_removed','memory_provenance_stale','memory_episode_changed','memory_episode_removed','memory_profile_history_save'];
const PROFILE_FIELDS=['facts','current_status','judgment','mbti','location','occupation','age_text','gender',
    'relationship_to_user','relationship_to_clara','relationship_nature','emotional_significance','relationship_category',
    'relationship_confidence','birthday','structured_facts','status_since','talking_points','aliases','tags'];
function installOperations(db) { db.transaction(()=>db.exec(OPERATIONS_SCHEMA))(); }
function tracked(db,stage,fn) {
    db.prepare(`INSERT INTO memory_pipeline_runs(stage,last_started_at) VALUES(?,CURRENT_TIMESTAMP)
        ON CONFLICT(stage) DO UPDATE SET last_started_at=CURRENT_TIMESTAMP`).run(stage);
    return Promise.resolve().then(fn).then(result=>{
        db.prepare(`UPDATE memory_pipeline_runs SET last_success_at=CURRENT_TIMESTAMP,last_error_code=NULL,success_count=success_count+1 WHERE stage=?`).run(stage);
        return result;
    },error=>{
        db.prepare(`UPDATE memory_pipeline_runs SET last_failure_at=CURRENT_TIMESTAMP,last_error_code='stage_failed',failure_count=failure_count+1 WHERE stage=?`).run(stage);
        throw error;
    });
}
function pipelineHealth(db,{expectedStages=[]}={}) {
    const objects=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger')").all().map(r=>r.name));
    const required=['memory_fragment_provenance','memory_derivation_reviews','episode_fragment_sources','memory_review_actions','memory_pipeline_runs',...REQUIRED_TRIGGERS];
    if(objects.has('user_model')) required.push('memory_entity_evidence','memory_entity_associations','memory_visible_profiles','memory_valid_episodes','memory_valid_user_model','memory_valid_patterns','memory_valid_sagas','memory_visible_fragments');
    const missing=required.filter(n=>!objects.has(n)),warnings=[];
    const count=sql=>db.prepare(sql).get().n;
    let reviews=[],provenance=[],runs=[];
    if(objects.has('memory_derivation_reviews')) reviews=db.prepare(`SELECT target_type,reason,COUNT(*) AS count,MIN(updated_at) AS oldest_at FROM memory_derivation_reviews GROUP BY target_type,reason`).all();
    if(objects.has('memory_fragment_provenance')) provenance=db.prepare('SELECT kind,state,COUNT(*) AS count FROM memory_fragment_provenance GROUP BY kind,state').all();
    if(objects.has('memory_pipeline_runs')) runs=db.prepare('SELECT * FROM memory_pipeline_runs ORDER BY stage').all();
    for(const stage of expectedStages) if(!runs.some(r=>r.stage===stage)) warnings.push({code:'stage_not_observed',stage});
    for(const run of runs) if(run.last_error_code) warnings.push({code:'stage_failed',stage:run.stage});
    if(reviews.length) warnings.push({code:'pending_source_reviews',count:reviews.reduce((n,r)=>n+r.count,0)});
    const counts={};
    if(objects.has('memory_fragments') && objects.has('memory_fragment_provenance')) counts.legacy_fragments=count('SELECT COUNT(*) n FROM memory_fragments f WHERE NOT EXISTS(SELECT 1 FROM memory_fragment_provenance p WHERE p.fragment_id=f.id)');
    if(objects.has('memory_fragments') && db.prepare('PRAGMA table_info(memory_fragments)').all().some(c=>c.name==='chroma_id')) counts.fragments_without_vector=count("SELECT COUNT(*) n FROM memory_fragments WHERE status='active' AND chroma_id IS NULL");
    if(objects.has('memories')) counts.episodes_without_vector=count("SELECT COUNT(*) n FROM memories WHERE layer='episode' AND status IN ('permanent','ongoing') AND chroma_id IS NULL");
    if(objects.has('scribe_runs')) {
        const last=db.prepare('SELECT status,run_at,processed_until,messages_processed,fragments_written FROM scribe_runs ORDER BY id DESC LIMIT 1').get();
        counts.last_scribe=last || null;
        if(last?.status==='failed') warnings.push({code:'scribe_failed'});
    }
    return {healthy:missing.length===0 && warnings.length===0,contracts_ready:missing.length===0,missing,warnings,counts,reviews,provenance,runs};
}
function assertContracts(db) {
    const health=pipelineHealth(db);
    if(!health.contracts_ready) throw Error(`Memory integrity contracts missing: ${health.missing.join(',')}`);
    return health;
}
function listReviews(db,limit=100) {
    return db.prepare('SELECT target_type,target_id,revision,reason,updated_at FROM memory_derivation_reviews ORDER BY updated_at,target_type,target_id LIMIT ?').all(Math.max(1,Math.min(limit,200)));
}
function resolveReview(db,type,id,body,{modelTable='user_model',patternTable='user_patterns',validateSources=()=>false,encodeContent=value=>value}={}) {
    const targets={profile:'entity_profiles',episode:'memories',[modelTable]:modelTable,pattern:patternTable,saga:'memory_sagas'};
    const table=targets[type];
    if(!table || !/^[a-z_][a-z_0-9]*$/.test(table) || !Number.isSafeInteger(id) || id<=0
        || !Number.isSafeInteger(body?.revision) || body.revision<=0 || !['replace','retire'].includes(body.action)) throw Object.assign(Error('Invalid review action'),{status:400});
    return db.transaction(()=>{
        const pending=db.prepare('SELECT * FROM memory_derivation_reviews WHERE target_type=? AND target_id=?').get(type,id);
        if(!pending || pending.revision!==body.revision) throw Object.assign(Error('Review revision changed; reload before reviewing'),{status:409});
        const before=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        // Deleted targets still need an explicit exit, recorded as retired.
        if(!before && body.action!=='retire') throw Object.assign(Error('Review target no longer exists'),{status:404});
        const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name));
        if(body.action==='retire' && before) {
            if(type==='profile') {
                const fields=PROFILE_FIELDS.filter(f=>columns.has(f));
                db.prepare(`UPDATE ${table} SET ${fields.map(f=>`${f}=NULL`).join(',')} WHERE id=?`).run(id);
            } else db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(type==='episode'?'archived':'superseded',id);
        } else if(before) {
            if(type==='saga') throw Object.assign(Error('Saga replacement requires a reviewed episode rebuild; retire is available'),{status:400});
            if(!validateSources(type,id,body.fragment_ids)) throw Object.assign(Error('Replacement needs currently verified source fragments'),{status:400});
            const allowed=type==='profile'?PROFILE_FIELDS:(type==='saga'?['title','description']:['content']);
            const values=body.values;
            if(!values || Array.isArray(values) || typeof values!=='object' || !Object.keys(values).length
                || Object.entries(values).some(([k,v])=>!allowed.includes(k) || !columns.has(k) || (v!==null && typeof v!=='string') || (typeof v==='string' && v.length>10000))) throw Object.assign(Error('Invalid reviewed values'),{status:400});
            const text=type==='profile'?values.facts:(type==='saga'?values.description:values.content);
            if(typeof text!=='string' || !text.trim()) throw Object.assign(Error('Reviewed factual content is required'),{status:400});
            const entries=Object.entries(values).map(([field,value])=>[field,type==='episode' && field==='content'?encodeContent(value):value]);
            if(type==='profile') for(const field of PROFILE_FIELDS) if(columns.has(field) && !Object.hasOwn(values,field)) entries.push([field,null]);
            db.prepare(`UPDATE ${table} SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id);
            if (columns.has('source_fragment_ids')) db.prepare(`UPDATE ${table} SET source_fragment_ids=? WHERE id=?`).run(JSON.stringify(body.fragment_ids),id);
            if (type==='episode') {
                const msgIds=[...new Set(body.fragment_ids.flatMap(fragmentId=>{try{return JSON.parse(db.prepare('SELECT source_msg_ids FROM memory_fragments WHERE id=?').get(fragmentId).source_msg_ids||'[]');}catch{return [];}}))];
                db.prepare('UPDATE memories SET source_msg_ids=?,chroma_id=NULL WHERE id=?').run(JSON.stringify(msgIds),id);
                db.prepare('DELETE FROM episode_fragment_sources WHERE memory_id=?').run(id);
                for (const fragmentId of body.fragment_ids) db.prepare('INSERT INTO episode_fragment_sources(memory_id,fragment_id,fully_covered) VALUES(?,?,0)').run(id,fragmentId);
            }
        }
        const after=before?db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id):null;
        db.prepare('INSERT INTO memory_review_actions(target_type,target_id,revision,action,before_json,after_json) VALUES(?,?,?,?,?,?)')
            .run(type,id,body.revision,body.action,JSON.stringify(before||null),JSON.stringify(after));
        // The target write may invalidate other targets; only remove the revision actually reviewed.
        const changed=db.prepare('DELETE FROM memory_derivation_reviews WHERE target_type=? AND target_id=? AND revision=?').run(type,id,body.revision).changes;
        if(changed!==1) throw Object.assign(Error('Target changed during review'),{status:409});
        return {reviewed:true,action:body.action};
    })();
}
function markSourceReviewed(db,fragmentId,{modelTable='user_model',patternTable='user_patterns'}={}) {
    if (![modelTable,patternTable].every(t=>/^[a-z_][a-z_0-9]*$/.test(t))) throw Error('Invalid source review tables');
    const targets=[['profile','SELECT entity_id AS id FROM fragment_entities WHERE fragment_id=?'],
        ['episode','SELECT memory_id AS id FROM episode_fragment_sources WHERE fragment_id=?'],
        [modelTable,`SELECT id FROM ${modelTable} WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(source_fragment_ids) THEN source_fragment_ids ELSE '[]' END) j WHERE j.value=?)`],
        ['pattern',`SELECT id FROM ${patternTable} WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(source_fragment_ids) THEN source_fragment_ids ELSE '[]' END) j WHERE j.value=?)`],
        ['saga',`SELECT id FROM memory_sagas WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(memory_ids) THEN memory_ids ELSE '[]' END) j WHERE j.value IN (SELECT memory_id FROM episode_fragment_sources WHERE fragment_id=?))`]];
    for(const [type,query] of targets) for(const row of db.prepare(query).all(fragmentId)) {
        db.prepare(`INSERT INTO memory_derivation_reviews(target_type,target_id,reason) VALUES(?,?,'manual_source_review')
            ON CONFLICT(target_type,target_id) DO UPDATE SET revision=revision+1,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP`).run(type,row.id);
    }
}
function startMonitor(getDb,{expectedStages=[],intervalMs=300000}={}) {
    assertContracts(getDb());
    let signature='';
    const check=()=>{
        try {
            const result=pipelineHealth(getDb(),{expectedStages});
            const next=JSON.stringify({missing:result.missing,warnings:result.warnings});
            if(next!==signature && (result.missing.length || result.warnings.length)) console.warn('[MemoryPipeline]',next);
            signature=next;
        } catch { console.error('[MemoryPipeline] diagnostic_failed'); }
    };
    check();
    const timer=setInterval(check,intervalMs);timer.unref();return ()=>clearInterval(timer);
}
module.exports={OPERATIONS_SCHEMA,REQUIRED_TRIGGERS,installOperations,tracked,pipelineHealth,assertContracts,listReviews,resolveReview,markSourceReviewed,startMonitor};
