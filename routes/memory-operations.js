const express=require('express');
const { createHash }=require('node:crypto');
const operations=require('../services/memoryOperations');
function fragmentVersion(row,provenance=null) {
    return createHash('sha256').update(JSON.stringify([row.content,row.source_date,row.source_msg_ids,row.status,provenance])).digest('hex');
}
function messageText(raw) {
    if(typeof raw!=='string') return '';
    try {
        const parsed=JSON.parse(raw),parts=Array.isArray(parsed)?parsed:parsed.components;
        if(Array.isArray(parts)) return parts.filter(p=>p?.type==='text').map(p=>p.text || p.content || '').join('\n');
    } catch {}
    return raw;
}
function createRouter({getDb,requireAuth,integrity,prepareSource,persistSource,sourceFor,decode=value=>value,
    modelTable='user_model',patternTable='user_patterns',encodeContent=value=>value,expectedStages=[]}={}) {
    const router=express.Router();
    router.use('/api/memory/pipeline',requireAuth);
    router.get('/api/memory/pipeline/health',(req,res)=>{
        try {res.json(operations.pipelineHealth(getDb(),{expectedStages}));} catch {res.status(503).json({error:'pipeline_diagnostic_failed'});}
    });
    router.get('/api/memory/pipeline/reviews',(req,res)=>{
        try {res.json({reviews:operations.listReviews(getDb(),Number(req.query.limit)||100)});} catch {res.status(503).json({error:'review_queue_unavailable'});}
    });
    router.post('/api/memory/pipeline/reviews/:type/:id',(req,res)=>{
        try {
            const db=getDb();
            const validateSources=(type,id,ids)=>{
                if(!Array.isArray(ids) || !ids.length || ids.length>100 || new Set(ids).size!==ids.length || ids.some(n=>!Number.isSafeInteger(n))) return false;
                return ids.every(fragmentId=>{
                    const fragment=db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(fragmentId),p=sourceFor(db,fragmentId);
                    if(!fragment || !['active','consolidated','cooling'].includes(fragment.status) || p?.state!=='quoted' || p.kind!=='user_fact') return false;
                    if(type==='profile') {
                        const link=db.prepare("SELECT * FROM fragment_entities WHERE fragment_id=? AND entity_id=? AND confidence>=0.7 AND (relation IS NULL OR relation IN ('direct','related_to','llm_resolved','visited','consumed','knows','cares_for','attended','created')) AND classified_by IN ('scribe_extract','resolver.llm','companion_flash','spotcheck_reclassify','manual_verified','manual_fix','manual_backfill')").get(fragmentId,id);
                        if(!link) return false;
                    }
                    return true;
                });
            };
            res.json(operations.resolveReview(db,req.params.type,Number(req.params.id),req.body,{modelTable,patternTable,validateSources,encodeContent}));
        } catch(e) {res.status(e.status||500).json({error:e.status?e.message:'review_failed'});}
    });
    router.get('/api/memory/pipeline/fragments/:id/source-review',(req,res)=>{
        try {
            const db=getDb(),id=Number(req.params.id),row=db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(id);
            if(!row) return res.status(404).json({error:'fragment_not_found'});
            const p=sourceFor(db,id),ids=new Set();
            for(const list of [row.source_msg_ids,p?.input_msg_ids]) {try {for(const n of JSON.parse(list||'[]')) if(Number.isSafeInteger(n)) ids.add(n);}catch{}}
            const messages=ids.size?db.prepare(`SELECT * FROM messages WHERE id IN (${[...ids].map(()=>'?').join(',')})`).all(...ids):[];
            res.json({fragment_id:id,version:fragmentVersion(row,p),provenance:p||null,
                messages:messages.map(m=>({id:m.id,sender:m.sender,chat_id:m.chat_id,chat_mode:m.chat_mode,is_rp:m.is_rp,timestamp:m.timestamp,text:messageText(decode(m.content))}))});
        } catch {res.status(500).json({error:'source_review_failed'});}
    });
    router.post('/api/memory/pipeline/fragments/:id/source-review',(req,res)=>{
        try {
            const db=getDb(),id=Number(req.params.id),entry=req.body;
            const result=db.transaction(()=>{
                const row=db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(id);
                if(!row) throw Object.assign(Error('Fragment not found'),{status:404});
                if(entry.version!==fragmentVersion(row,sourceFor(db,id)||null)) throw Object.assign(Error('Fragment changed; reload first'),{status:409});
                if(!Array.isArray(entry.evidence) || !entry.evidence.length || entry.evidence.length>12) throw Object.assign(Error('Exact source quotations required'),{status:400});
                const ids=[...new Set(entry.evidence.map(e=>e.message_id))];
                if(ids.some(n=>!Number.isSafeInteger(n) || n<=0)) throw Object.assign(Error('Invalid source IDs'),{status:400});
                const messages=db.prepare(`SELECT * FROM messages WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(m=>({...m,text:messageText(decode(m.content))}));
                const prepared=prepareSource(entry,messages,new Set(ids));
                if(prepared.state!=='quoted') throw Object.assign(Error('Source quotation, author or context could not be verified'),{status:400});
                // UPDATE preserves the dependency triggers; deleting provenance would hide the change.
                const old=sourceFor(db,id);
                if(old) db.prepare('UPDATE memory_fragment_provenance SET kind=?,state=?,evidence_json=?,input_msg_ids=?,updated_at=CURRENT_TIMESTAMP WHERE fragment_id=?')
                    .run(prepared.kind,prepared.state,JSON.stringify(prepared.evidence),JSON.stringify(ids),id);
                else persistSource(db,id,prepared,ids);
                db.prepare('UPDATE memory_fragments SET source_msg_ids=? WHERE id=?').run(JSON.stringify(prepared.msgIds),id);
                // Updating IDs invalidates old provenance; this transaction has just checked these quotes.
                db.prepare("UPDATE memory_fragment_provenance SET state='quoted' WHERE fragment_id=?").run(id);
                operations.markSourceReviewed(db,id,{modelTable,patternTable});
                return {reviewed:true,fragment_id:id,kind:prepared.kind};
            })();
            res.json(result);
        } catch(e) {res.status(e.status||500).json({error:e.status?e.message:'source_review_failed'});}
    });
    return router;
}
module.exports={createRouter,fragmentVersion,messageText};
