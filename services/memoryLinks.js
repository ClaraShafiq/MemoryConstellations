// An organizational link is not evidence of a fact about its owner.
const FACT_SOURCES = ['scribe_extract','resolver.llm','companion_flash','spotcheck_reclassify','manual_verified','manual_fix','manual_backfill'];
const TOPIC_SOURCES = ['tag_routing','aggregate_link','aggregate_backfill','intimacy_absorb'];
const FACT_RELATIONS = ['direct','related_to','llm_resolved','visited','consumed','knows','cares_for','attended','created'];
const CONTEXT_RELATIONS = ['interaction','opinion','fictional','third_party'];
const sqlList = values=>values.map(v=>`'${v}'`).join(',');
function evidenceSQL(alias='fe') {
    if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) throw Error('Invalid alias');
    return `(typeof(${alias}.confidence) IN ('real','integer') AND ${alias}.confidence BETWEEN 0.7 AND 1
      AND ${alias}.classified_by IN (${sqlList(FACT_SOURCES)})
      AND (${alias}.relation IS NULL OR ${alias}.relation IN (${sqlList(FACT_RELATIONS)}))
      AND NOT EXISTS(SELECT 1 FROM memory_fragment_provenance p WHERE p.fragment_id=${alias}.fragment_id AND (p.kind!='user_fact' OR p.state!='quoted')))`;
}
function associationSQL(alias='fe') {
    return `(${evidenceSQL(alias)} OR (COALESCE(${alias}.relation,'') NOT IN ('rejected','candidate','mentioned')
      AND ${alias}.confidence BETWEEN 0 AND 1 AND (${alias}.relation='topic' OR ${alias}.classified_by IN (${sqlList(TOPIC_SOURCES)}))
      AND EXISTS(SELECT 1 FROM entity_profiles ep WHERE ep.id=${alias}.entity_id AND ep.category GLOB '*_aggregate'))
      OR (${alias}.confidence BETWEEN 0.7 AND 1 AND ${alias}.classified_by IN (${sqlList(FACT_SOURCES)})
      AND ${alias}.relation IN (${sqlList(CONTEXT_RELATIONS)}) AND EXISTS(SELECT 1 FROM memory_fragment_provenance p
        WHERE p.fragment_id=${alias}.fragment_id AND p.state='quoted' AND p.kind!='unverified')))`;
}
function normalize(relation,producer) {
    if (relation==='rejected') return relation;
    if (TOPIC_SOURCES.includes(producer)) return 'topic';
    if (!FACT_SOURCES.includes(producer)) return 'candidate';
    if (!relation) return 'direct';
    return [...FACT_RELATIONS,...CONTEXT_RELATIONS,'candidate','mentioned'].includes(relation) ? relation : 'candidate';
}
function writeLink(db,fragmentId,entityId,relation,confidence,producer) {
    if (!Number.isSafeInteger(fragmentId) || fragmentId<=0 || !Number.isSafeInteger(entityId) || entityId<=0
        || !Number.isFinite(confidence) || confidence<0 || confidence>1 || typeof producer!=='string' || !producer) throw Error('Invalid entity link');
    relation=normalize(relation,producer);
    return db.transaction(()=>{
        const old=db.prepare('SELECT * FROM fragment_entities WHERE fragment_id=? AND entity_id=?').get(fragmentId,entityId);
        if (old?.relation==='rejected' || (old?.classified_by?.startsWith('manual_') && !producer.startsWith('manual_'))) return false;
        const fact=x=>x && FACT_SOURCES.includes(x.classified_by) && x.confidence>=0.7 && (x.relation==null || FACT_RELATIONS.includes(x.relation));
        const incoming={classified_by:producer,confidence,relation};
        if (relation!=='rejected' && old && ((fact(old) && !fact(incoming)) || (fact(old)===fact(incoming) && old.confidence>=confidence))) return false;
        if (old) db.prepare('UPDATE fragment_entities SET relation=?,confidence=?,classified_by=? WHERE fragment_id=? AND entity_id=?').run(relation,confidence,producer,fragmentId,entityId);
        else db.prepare('INSERT INTO fragment_entities(fragment_id,entity_id,relation,confidence,classified_by) VALUES(?,?,?,?,?)').run(fragmentId,entityId,relation,confidence,producer);
        db.prepare(`UPDATE entity_profiles SET fragment_count=(SELECT COUNT(*) FROM fragment_entities fe WHERE fe.entity_id=? AND ${associationSQL()}) WHERE id=?`).run(entityId,entityId);
        return true;
    })();
}
function linkWriter(db,parameters,defaults={}) {
    const allowed=['fragment_id','entity_id','relation','confidence','classified_by'];
    if (parameters.some(p=>!allowed.includes(p)) || new Set(parameters).size!==parameters.length) throw Error('Invalid writer parameters');
    return {run(...args){
        if(args.length!==parameters.length) throw Error('Invalid writer argument count');
        const v={relation:null,...defaults};parameters.forEach((p,i)=>{v[p]=args[i];});
        return {changes:Number(writeLink(db,Number(v.fragment_id),Number(v.entity_id),v.relation,v.confidence,v.classified_by))};
    }};
}
function resolveName(db,name) {
    if (typeof name!=='string' || !name.trim()) return null;
    const key=name.trim().toLowerCase();
    const rows=db.prepare("SELECT * FROM memory_visible_profiles WHERE status IN ('active','seed','dormant')").all();
    const exact=rows.filter(r=>r.name?.toLowerCase()===key);
    if(exact.length) return exact.length===1 ? exact[0]:null;
    const matches=rows.filter(r=>{try{return JSON.parse(r.aliases||'[]').some(a=>typeof a==='string' && a.trim().toLowerCase()===key);}catch{return false;}});
    return matches.length===1 ? matches[0]:null;
}
module.exports={evidenceSQL,associationSQL,writeLink,linkWriter,resolveName};
