const { createHash } = require('node:crypto');
const { associationSQL, evidenceSQL } = require('./memoryLinks');
const { sourceFor } = require('./memoryIntegrity');
function version(fragment,source) {
    return createHash('sha256').update(JSON.stringify([fragment.content,fragment.source_date,fragment.source_msg_ids,
        source?.kind,source?.state,source?.evidence_json])).digest('hex');
}
function prepareEpisodeBatch(outputs,fragments,{indexBase=0,minSources=3,db}={}) {
    if(!Array.isArray(outputs)) return [];
    const results=[],seen=new Set();
    for(const output of outputs) {
        const indices=output?.fragment_indices,covered=output?.covered_fragment_indices;
        if(typeof output?.merged_memory!=='string' || output.merged_memory.trim().length<20 || !Array.isArray(indices)
            || !Array.isArray(covered) || !Number.isFinite(output.significance) || output.significance<4 || output.significance>10) continue;
        if(new Set(indices).size!==indices.length || indices.length<(output.operation==='split'?1:minSources)
            || indices.some(i=>!Number.isSafeInteger(i) || i<indexBase || !fragments[i-indexBase])
            || new Set(covered).size!==covered.length || covered.some(i=>!indices.includes(i))) continue;
        const selected=indices.map(i=>fragments[i-indexBase]);
        if(new Set(selected.map(f=>f.id)).size!==selected.length) continue;
        const date=output.corrected_date || selected.map(f=>f.source_date).filter(Boolean).sort()[0] || null;
        if(date) {
            if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const parsed=new Date(`${date}T00:00:00Z`);
            if(!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date) continue;
        }
        const content=output.merged_memory.trim(),key=JSON.stringify([content,selected.map(f=>f.id).sort((a,b)=>a-b)]);
        if(seen.has(key)) continue;
        seen.add(key);
        const msgIds=[...new Set(selected.flatMap(f=>{try{return JSON.parse(f.source_msg_ids||'[]').filter(Number.isSafeInteger);}catch{return [];}}))];
        results.push({output,episode:{content,date,selected,msgIds,weight:Math.round(output.significance),
            coveredIds:covered.map(i=>fragments[i-indexBase].id),
            snapshots:db ? new Map(selected.map(f=>[f.id,f._source_version || version(f,sourceFor(db,f.id))])) : null}});
    }
    const uses=new Map();
    for(const {episode} of results) for(const f of episode.selected) uses.set(f.id,(uses.get(f.id)||0)+1);
    for(const {episode} of results) episode.coveredIds=episode.coveredIds.filter(id=>uses.get(id)===1);
    return results;
}
function persistEpisode(db,episode,{entityId=null,share=false,consolidationType='standard'}={}) {
    return db.transaction(()=>{
        const kinds=new Set();
        for(const original of episode.selected) {
            const fresh=db.prepare("SELECT * FROM memory_fragments WHERE id=? AND status='active'").get(original.id),source=sourceFor(db,original.id);
            if(!fresh || fresh.content!==original.content || fresh.source_date!==original.source_date || fresh.source_msg_ids!==original.source_msg_ids
                || (episode.snapshots && version(fresh,source)!==episode.snapshots.get(original.id))) throw Error('Episode source changed');
            if(source && source.state!=='quoted') throw Error('Episode source is unverified');
            kinds.add(source?.kind || 'unverified');
            if(entityId!==null && !db.prepare(`SELECT 1 FROM fragment_entities fe WHERE fe.fragment_id=? AND fe.entity_id=? AND ${associationSQL()}`).get(original.id,entityId)) throw Error('Episode attribution changed');
        }
        if(kinds.size!==1) throw Error('Mixed source contexts must be split');
        const tags=JSON.stringify([`memory_kind:${[...kinds][0]}`]);
        const owners=[{entity_id:entityId}];
        if(share && entityId!==null) owners.push(...db.prepare(`SELECT fe.entity_id FROM fragment_entities fe
            WHERE fe.fragment_id IN (${episode.selected.map(()=>'?').join(',')}) AND fe.entity_id!=? AND ${evidenceSQL()}
            GROUP BY fe.entity_id HAVING COUNT(DISTINCT fe.fragment_id)=?`).all(...episode.selected.map(f=>f.id),entityId,episode.selected.length));
        const rows=[];
        for(const owner of owners) {
            const duplicate=db.prepare(`SELECT id FROM memories m WHERE entity_id IS ? AND content=?
                AND (SELECT COUNT(*) FROM episode_fragment_sources s WHERE s.memory_id=m.id)=?
                AND (SELECT COUNT(*) FROM episode_fragment_sources s WHERE s.memory_id=m.id AND s.fragment_id IN (${episode.selected.map(()=>'?').join(',')}))=?`)
                .get(owner.entity_id,episode.content,episode.selected.length,...episode.selected.map(f=>f.id),episode.selected.length);
            if(duplicate) throw Error('Duplicate episode from the same sources');
            const result=db.prepare(`INSERT INTO memories(title,content,weight,valid_from,status,source_msg_ids,entity_id,layer,consolidation_type,audit_status,tags)
                VALUES(?,?,?,?,'permanent',?,?,'episode',?,'pending',?)`).run(episode.content.slice(0,50),episode.content,episode.weight,episode.date,JSON.stringify(episode.msgIds),owner.entity_id,consolidationType,tags);
            const id=Number(result.lastInsertRowid);
            for(const f of episode.selected) db.prepare('INSERT INTO episode_fragment_sources(memory_id,fragment_id,fully_covered) VALUES(?,?,?)').run(id,f.id,Number(episode.coveredIds.includes(f.id)));
            rows.push({...owner,memoryId:id});
        }
        for(const id of episode.coveredIds) db.prepare("UPDATE memory_fragments SET status='consolidated' WHERE id=?").run(id);
        return rows;
    })();
}
module.exports={prepareEpisodeBatch,persistEpisode,version};
