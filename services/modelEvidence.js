const { createHash } = require('node:crypto');
const { sourceFor,revision } = require('./memoryIntegrity');
function snapshot(entry,fragment,source) {
    return createHash('sha256').update(JSON.stringify([entry.content,entry.type,entry.status,fragment.content,
        fragment.source_msg_ids,fragment.source_date,source?.kind,source?.state,source?.evidence_json])).digest('hex');
}
function eligible(db,entry,fragment,source) {
    return entry?.status==='active' && entry.type!=='immutable_fact' && fragment
        && ['active','consolidated','cooling'].includes(fragment.status) && source?.state==='quoted'
        && source.kind==='user_fact' && !revision(db,'user_model',entry.id);
}
function verifiedSupport(db,entry,fragmentId) {
    const fragment=db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(fragmentId),source=sourceFor(db,fragmentId);
    if(!eligible(db,entry,fragment,source)) return null;
    const check=db.prepare('SELECT * FROM memory_model_evidence_checks WHERE entry_id=? AND fragment_id=?').get(entry.id,fragmentId);
    return check?.supports && check.snapshot===snapshot(entry,fragment,source) ? JSON.parse(source.evidence_json).map(e=>e.message_id) : null;
}
async function matchFragments(db,fragments,{findCandidates,judge,addEvidence}={}) {
    let checked=0,matched=0;
    for(const fragment of fragments) {
        const source=sourceFor(db,fragment.id);
        if(source?.state!=='quoted' || source.kind!=='user_fact') continue;
        for(const candidate of await findCandidates(fragment.content)) {
            const entry=db.prepare('SELECT * FROM user_model WHERE id=?').get(candidate.id);
            if(!eligible(db,entry,fragment,source)) continue;
            const version=snapshot(entry,fragment,source);
            const previous=db.prepare('SELECT snapshot FROM memory_model_evidence_checks WHERE entry_id=? AND fragment_id=?').get(entry.id,fragment.id);
            if(previous?.snapshot===version) continue;
            const evidence=JSON.parse(source.evidence_json),decision=await judge(entry,evidence);
            const quote=typeof decision?.quote==='string'?decision.quote.trim():'';
            const supports=decision?.supports===true && quote.length>=2 && evidence.some(e=>e.quote.includes(quote));
            db.transaction(()=>{
                const current=db.prepare('SELECT * FROM user_model WHERE id=?').get(entry.id),fresh=db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(fragment.id),provenance=sourceFor(db,fragment.id);
                if(!eligible(db,current,fresh,provenance) || snapshot(current,fresh,provenance)!==version) return;
                db.prepare(`INSERT INTO memory_model_evidence_checks(entry_id,fragment_id,snapshot,supports,quote) VALUES(?,?,?,?,?)
                    ON CONFLICT(entry_id,fragment_id) DO UPDATE SET snapshot=excluded.snapshot,supports=excluded.supports,quote=excluded.quote,checked_at=CURRENT_TIMESTAMP`)
                    .run(entry.id,fragment.id,version,Number(supports),quote);
                checked++;
                if(supports && addEvidence(entry.id,fragment.id,true)) matched++;
            })();
        }
    }
    return {checked,matched};
}
function cosine(a,b) {
    if(!Array.isArray(a) || !Array.isArray(b) || a.length!==b.length || !a.length) return -1;
    let dot=0,left=0,right=0;
    for(let i=0;i<a.length;i++) {if(!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return -1;dot+=a[i]*b[i];left+=a[i]*a[i];right+=b[i]*b[i];}
    return left && right ? dot/Math.sqrt(left*right) : -1;
}
module.exports={snapshot,verifiedSupport,matchFragments,cosine};
