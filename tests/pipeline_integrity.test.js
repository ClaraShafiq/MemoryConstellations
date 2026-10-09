// Real SQLite, production routes/services, synthetic records. Only external LLM/vector calls are substituted.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'constellations-integrity-'));
process.env.CHROMA_URL='http://fixture.invalid';
const realFetch=global.fetch;
global.fetch=async(url,options)=>{
    const address=String(url);
    if(address.startsWith('http://fixture.invalid/')) {
        const body=options?.body?JSON.parse(options.body):{};
        const result=address.endsWith('/embed')?{embedding:[1,0,0]}:address.endsWith('/query')?{ids:[[]],distances:[[]]}:address.endsWith('/query_multi')?{results:[]}:{success:true,indexed:body.items?.length||0,duplicates:[]};
        return new Response(JSON.stringify(result),{status:200});
    }
    if(base && address.startsWith(base+'/')) return realFetch(url,options);
    throw Error('Unexpected external transport in isolated fixture');
};
process.env.DB_PATH=path.join(dir,'fixture.db');
process.env.SANCTUARY_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
const db=require('../database').initDatabase();
const integrity=require('../services/memoryIntegrity'),links=require('../services/memoryLinks');
const episodes=require('../services/episodeWriter'),operations=require('../services/memoryOperations');
let llmReply=async()=>({reply:'{"entries":[]}'});
const llmPath=require.resolve('../services/llm');
require.cache[llmPath]={id:llmPath,filename:llmPath,loaded:true,exports:{callLLM:(...args)=>llmReply(...args)}};
const memory=require('../services/memory');
memory.chromaDBOperation=async action=>action==='query'?{ids:[[]],distances:[[]]}:{success:true,indexed:1,duplicates:[]};
memory.getLocalEmbedding=async()=>[1,0,0];
const express=require('express'),{createRouter,fragmentVersion}=require('../routes/memory-operations');
const app=express();app.use(express.json());
app.use(createRouter({getDb:()=>db,requireAuth:(req,res,next)=>req.headers['x-fixture-auth']==='yes'?next():res.sendStatus(401),...integrity}));
app.use('/api',require('../routes/ingest'));
app.use('/api',require('../routes/recall'));
let server,base,counter=0;
test.before(async()=>{
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
    // Exercise production ingress to bootstrap the parent; don't mask a missing-chat bug with fixture SQL.
    assert.equal((await request('/api/messages',{sender:'user',content:'Fixture bootstrap',timestamp:'2026-10-09 09:00:00'})).status,200);
});
test.after(async()=>{global.fetch=realFetch;require('../services/archivist').stop();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
async function request(url,body,auth=true) {
    const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(auth?{'x-fixture-auth':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json().catch(()=>null)};
}
function entity(category='person',name=`Fixture Actor ${++counter}`) {
    return Number(db.prepare("INSERT INTO entity_profiles(name,category,status,aliases) VALUES(?,?,'active','[]')").run(name,category).lastInsertRowid);
}
function fragment(owner,{kind='user_fact',sender='user',mode='default',text=`Fixture statement ${++counter}: attended an exhibition.`,quoted=true}={}) {
    const messageId=Number(db.prepare("INSERT INTO messages(chat_id,sender,content,timestamp,status,chat_mode,is_rp) VALUES(1,?,?,?,'sent',?,?)").run(sender,text,'2026-10-09 10:00:00',mode,Number(mode==='roleplay')).lastInsertRowid);
    const message=db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    const source=integrity.prepareSource({memory_kind:kind,evidence:[{message_id:messageId,quote:text}]},[{...message,text}],new Set([messageId]));
    const id=Number(db.prepare("INSERT INTO memory_fragments(type,entity,content,source_date,source_msg_ids,status,emotional_weight) VALUES('event','',?,'2026-10-09',?,'active',0.5)").run(text,JSON.stringify([messageId])).lastInsertRowid);
    if(quoted) integrity.persistSource(db,id,source,[messageId]);
    if(owner) links.writeLink(db,id,owner,kind==='user_fact'?'direct':'interaction',0.8,'scribe_extract');
    return db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(id);
}
const output=(indices,covered=indices)=>({fragment_indices:indices,covered_fragment_indices:covered,significance:7,merged_memory:'A synthetic exhibition event, preserving its original time and scope.'});

test('fresh schema has mandatory triggers and views; dropped trigger fails startup contract',()=>{
    assert.equal(operations.assertContracts(db).contracts_ready,true);
    assert.throws(()=>db.transaction(()=>{db.exec('DROP TRIGGER memory_source_changed');assert.throws(()=>operations.assertContracts(db),/memory_source_changed/);throw Error('rollback');})(),/rollback/);
    assert.equal(operations.assertContracts(db).contracts_ready,true);
});
test('source quote, real author and per-entry roleplay context are checked',()=>{
    const rows=[{id:1,text:'I prefer direct replies.',content:'I prefer direct replies.',sender:'user',chat_id:1,chat_mode:'default',status:'sent'},
        {id:2,text:'I am a wizard.',content:'I am a wizard.',sender:'user',chat_id:1,chat_mode:'roleplay',status:'sent'},
        {id:3,text:'You are always calm.',content:'You are always calm.',sender:'ai',chat_id:1,chat_mode:'default',status:'sent'}];
    const prepare=e=>integrity.prepareSource(e,rows,new Set([1,2,3]));
    assert.equal(prepare({memory_kind:'user_fact',evidence:[{message_id:2,quote:'a wizard'}]}).kind,'fiction');
    for(const evidence of [[{message_id:1,quote:'invented fact'}],[{message_id:3,quote:'always calm'}],[{message_id:1,quote:'direct replies'},{message_id:2,quote:'a wizard'}]])
        assert.equal(prepare({memory_kind:'user_fact',evidence}).state,'pending');
});
test('ambiguous aliases do not pick the first identity',()=>{
    const a=entity(),b=entity();
    db.prepare('UPDATE entity_profiles SET aliases=? WHERE id IN (?,?)').run('["shared alias"]',a,b);
    assert.equal(links.resolveName(db,'shared alias'),null);
    assert.equal(links.resolveName(db,'shared'),null);
});
test('organizational links remain browseable without becoming fact evidence; tombstones survive automation',()=>{
    const owner=entity(),topic=entity('test_aggregate'),f=fragment(null);
    links.writeLink(db,f.id,owner,'keyword',0.9,'resolver.keyword');
    links.writeLink(db,f.id,topic,null,0.85,'tag_routing');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_entity_evidence WHERE fragment_id=?').get(f.id).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_entity_associations WHERE fragment_id=?').get(f.id).n,1);
    db.prepare("UPDATE fragment_entities SET relation='rejected',classified_by='manual_verified',confidence=0 WHERE fragment_id=? AND entity_id=?").run(f.id,owner);
    assert.equal(links.writeLink(db,f.id,owner,'direct',1,'resolver.llm'),false);
});
test('episode transaction preserves partial coverage and prevents cross-owner narrative copying',()=>{
    const a=entity(),b=entity(),frags=[fragment(a),fragment(a),fragment(a),fragment(a)];
    for(const f of frags.slice(0,3)) links.writeLink(db,f.id,b,'direct',0.8,'scribe_extract');
    const prepared=episodes.prepareEpisodeBatch([output([0,1,2,3],[0])],frags,{db});
    const rows=episodes.persistEpisode(db,prepared[0].episode,{entityId:a,share:true});
    assert.equal(rows.length,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_fragment_sources WHERE memory_id=?').get(rows[0].memoryId).n,4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_fragments WHERE id IN (?,?,?,?) AND status='active'").get(...frags.map(f=>f.id)).n,3);
});
test('split outputs keep their mixed source active; invalid indices and calendar dates are rejected',()=>{
    const f=fragment(entity());
    const splits=[{...output([0]),operation:'split'},{...output([0]),operation:'split',merged_memory:'Another independent synthetic event from the same mixed source.'}];
    const prepared=episodes.prepareEpisodeBatch(splits,[f],{db});
    assert.equal(prepared.length,2);assert.ok(prepared.every(p=>p.episode.coveredIds.length===0));
    for(const p of prepared) episodes.persistEpisode(db,p.episode);
    assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(f.id).status,'active');
    for(const bad of [{...output([0,0,0])},{...output([0,1,2]),corrected_date:'2026-02-30'},{...output([0,1,1.5])}])
        assert.equal(episodes.prepareEpisodeBatch([bad],[f,f,f],{db}).length,0);
});
test('changed sources and failed transactions cannot consume source fragments',()=>{
    const owner=entity(),frags=[fragment(owner),fragment(owner),fragment(owner)];
    const prepared=episodes.prepareEpisodeBatch([output([0,1,2])],frags,{db})[0].episode;
    db.prepare("UPDATE memory_fragments SET content='Changed source' WHERE id=?").run(frags[0].id);
    const before=db.prepare('SELECT COUNT(*) n FROM memories').get().n;
    assert.throws(()=>episodes.persistEpisode(db,prepared,{entityId:owner}),/source changed/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n,before);
    assert.ok(frags.every(f=>db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(f.id).status==='active'));
});
test('original message edits quarantine profiles, episodes, model, pattern and saga in the same transaction',()=>{
    const owner=entity(),frags=[fragment(owner),fragment(owner),fragment(owner)];
    db.prepare("UPDATE entity_profiles SET facts='Old fact',relationship_category='old category',birthday='2000-01-01' WHERE id=?").run(owner);
    const episode=episodes.persistEpisode(db,episodes.prepareEpisodeBatch([output([0,1,2],[])],frags,{db})[0].episode,{entityId:owner})[0].memoryId;
    const model=Number(db.prepare("INSERT INTO user_model(type,content,status,source_fragment_ids) VALUES('stable_trait','Synthetic claim','active',?)").run(JSON.stringify([frags[0].id])).lastInsertRowid);
    const pattern=Number(db.prepare("INSERT INTO user_patterns(content,status,source_fragment_ids) VALUES('Synthetic pattern','active',?)").run(JSON.stringify([frags[0].id])).lastInsertRowid);
    const saga=Number(db.prepare("INSERT INTO memory_sagas(title,description,status,memory_ids) VALUES('Synthetic saga','Synthetic description','active',?)").run(JSON.stringify([episode])).lastInsertRowid);
    const messageId=JSON.parse(frags[0].source_msg_ids)[0];
    db.prepare("UPDATE messages SET content='Corrected original message' WHERE id=?").run(messageId);
    for(const [type,id] of [['profile',owner],['episode',episode],['user_model',model],['pattern',pattern],['saga',saga]]) assert.ok(integrity.revision(db,type,id)>0,type);
    const masked=db.prepare('SELECT * FROM memory_visible_profiles WHERE id=?').get(owner);
    for(const key of ['facts','relationship_category','birthday']) assert.equal(masked[key],null);
    assert.equal(db.prepare('SELECT id FROM memory_valid_episodes WHERE id=?').get(episode),undefined);
});
test('real rendering rejects stale cached/vector text and shows the fresh database wording',()=>{
    const owner=entity(),f=fragment(owner),librarian=require('../services/librarian');
    assert.match(librarian.formatHybridContext([{...f,source_table:'fragment',content:'STALE VECTOR TEXT'}]),/Fixture statement/);
    assert.doesNotMatch(librarian.formatHybridContext([{...f,source_table:'fragment',content:'STALE VECTOR TEXT'}]),/STALE VECTOR TEXT/);
    db.prepare("UPDATE fragment_entities SET relation='rejected' WHERE fragment_id=?").run(f.id);
    db.prepare("UPDATE messages SET content='Source corrected' WHERE id=?").run(JSON.parse(f.source_msg_ids)[0]);
    assert.equal(librarian.formatHybridContext([{...f,source_table:'fragment'}]),'');
});
test('no-source or same-topic support cannot raise cognitive confidence; checked source is used once',async()=>{
    const model=require('../services/cognitiveModel'),{matchFragments}=require('../services/modelEvidence');
    const id=model.createEntry('stable_trait','Fixture tendency',{confidence:0.5}),f=fragment(entity());
    assert.equal(model.addEvidence(id,null),null);
    const before=db.prepare('SELECT evidence_count FROM user_model WHERE id=?').get(id).evidence_count;
    await matchFragments(db,[f],{findCandidates:async()=>[{id}],judge:async()=>({supports:false,quote:''}),addEvidence:model.addEvidence});
    assert.equal(db.prepare('SELECT evidence_count FROM user_model WHERE id=?').get(id).evidence_count,before);
    const f2=fragment(entity());
    await matchFragments(db,[f2],{findCandidates:async()=>[{id}],judge:async()=>({supports:true,quote:f2.content}),addEvidence:model.addEvidence});
    assert.equal(db.prepare('SELECT evidence_count FROM user_model WHERE id=?').get(id).evidence_count,before+1);
    assert.equal(model.addEvidence(id,f2.id),null);
});
test('authenticated review API offers replacement/retirement and refuses stale revisions',async()=>{
    const owner=entity(),f=fragment(owner);
    db.prepare("UPDATE fragment_entities SET confidence=0.9 WHERE fragment_id=?").run(f.id);
    const version=integrity.revision(db,'profile',owner);
    assert.equal((await request('/api/memory/pipeline/health',null,false)).status,401);
    assert.equal((await request('/api/memory/pipeline/reviews/profile/'+owner,{revision:version-1,action:'retire'})).status,version===1?400:409);
    assert.equal((await request('/api/memory/pipeline/reviews/profile/'+owner,{revision:version,action:'replace',fragment_ids:[f.id],values:{facts:'Reviewed fixture fact.'}})).status,200);
    assert.equal(integrity.revision(db,'profile',owner),0);
    db.prepare("UPDATE fragment_entities SET confidence=0.95 WHERE fragment_id=?").run(f.id);
    assert.equal((await request('/api/memory/pipeline/reviews/profile/'+owner,{revision:integrity.revision(db,'profile',owner),action:'retire'})).status,200);
    assert.equal(db.prepare('SELECT facts FROM entity_profiles WHERE id=?').get(owner).facts,null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_review_actions WHERE target_id=?').get(owner).n,2);
});
test('manual legacy source review does not fabricate evidence and has a real dependency exit',async()=>{
    const owner=entity(),f=fragment(owner,{quoted:false});
    const loaded=await request(`/api/memory/pipeline/fragments/${f.id}/source-review`);
    const body={version:loaded.body.version,memory_kind:'user_fact',evidence:[{message_id:loaded.body.messages[0].id,quote:f.content}]};
    assert.equal((await request(`/api/memory/pipeline/fragments/${f.id}/source-review`,{...body,evidence:[{message_id:body.evidence[0].message_id,quote:'fabricated quotation'}]})).status,400);
    assert.equal((await request(`/api/memory/pipeline/fragments/${f.id}/source-review`,body)).status,200);
    assert.equal(integrity.sourceFor(db,f.id).state,'quoted');
    assert.ok(integrity.revision(db,'profile',owner)>0);
});
test('diagnostics expose failure codes/counts but not private text; review commits reject concurrent changes',async()=>{
    await assert.rejects(operations.tracked(db,'fixture_failure',async()=>{throw Error('SECRET_MESSAGE_TEXT');}));
    const health=operations.pipelineHealth(db);
    assert.ok(health.warnings.some(w=>w.code==='stage_failed'));
    assert.doesNotMatch(JSON.stringify(health),/SECRET_MESSAGE_TEXT|Fixture statement|Old fact/);
    const owner=entity(),f=fragment(owner);db.prepare('UPDATE fragment_entities SET confidence=0.9 WHERE fragment_id=?').run(f.id);
    const version=integrity.revision(db,'profile',owner);db.prepare('UPDATE fragment_entities SET confidence=0.95 WHERE fragment_id=?').run(f.id);
    let wrote=false;assert.equal(integrity.commitReview(db,'profile',owner,version,()=>{wrote=true;}),false);assert.equal(wrote,false);
});
test('actual ingest → scheduled Scribe entry → event listener → recall path works with synthetic messages',async()=>{
    // New messages are newer than all prior fixture sources; source metadata is re-read by Scribe.
    db.prepare("INSERT INTO scribe_runs(processed_until,status) VALUES('2026-10-09 11:00:00','done')").run();
    const owner=entity('person','Fixture Pipeline Actor');
    const msgs=Array.from({length:100},(_,i)=>({sender:'user',content:i===0?'Fixture Pipeline Actor attended the fixture gallery.':`Fixture filler ${i}`,timestamp:`2026-10-09 12:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}`}));
    assert.equal((await request('/api/messages',msgs)).status,200);
    const m=db.prepare("SELECT * FROM messages WHERE content='Fixture Pipeline Actor attended the fixture gallery.'").get();
    llmReply=async(_messages,system)=>({reply:system?.includes('输出格式')?JSON.stringify({entries:[{type:'event',content:m.content,memory_kind:'user_fact',evidence:[{message_id:m.id,quote:m.content}],entities:[{name:'Fixture Pipeline Actor',relation:'direct'}]}]}):'{"resolutions":[]}'});
    const archivist=require('../services/archivist');await archivist.start();assert.ok(archivist.archivistEvents.listenerCount('fragments:written')>0);
    await require('../services/scribe').checkAndRunScribe();
    archivist.stop();
    const created=db.prepare('SELECT * FROM memory_fragments WHERE content=?').get(m.content);
    assert.ok(created);assert.deepEqual(JSON.parse(created.source_msg_ids),[m.id]);
    assert.equal(db.prepare('SELECT entity_id FROM memory_entity_evidence WHERE fragment_id=?').get(created.id).entity_id,owner);
    const recalled=await request('/api/recall',{query:'Fixture Pipeline Actor',limit:10});
    assert.equal(recalled.status,200);assert.match(recalled.body.formatted,/fixture gallery/);
    db.prepare("UPDATE messages SET content='Corrected fixture source' WHERE id=?").run(m.id);
    assert.doesNotMatch((await request('/api/recall',{query:'Fixture Pipeline Actor',limit:10})).body.formatted,/fixture gallery/);
});

test('automatic identity candidates enter review; manual merge preserves rejection tombstones',async()=>{
 const archivist=require('../services/archivist'),a=entity('person','Fixture Identity Alpha'),b=entity('person','Fixture Identity Beta');
 db.prepare('UPDATE entity_profiles SET aliases=? WHERE id=?').run('["Fixture Identity Beta"]',a);
 const f=fragment(b);db.prepare("UPDATE fragment_entities SET relation='rejected',classified_by='manual_verified',confidence=0 WHERE fragment_id=? AND entity_id=?").run(f.id,b);
 await archivist.mergeDuplicateSeeds();
 assert.equal(db.prepare('SELECT status FROM entity_profiles WHERE id=?').get(b).status,'active');
 assert.equal(archivist.executeEntityMerge(a,b),false);
 assert.equal(archivist.executeEntityMerge(a,b,{identityConfirmed:true}),true);
 assert.equal(db.prepare('SELECT relation FROM fragment_entities WHERE fragment_id=? AND entity_id=?').get(f.id,a).relation,'rejected');
 assert.equal(links.writeLink(db,f.id,a,'direct',1,'resolver.llm'),false);
});
test('manual source review rejects concurrently changed provenance even when fragment text is unchanged',async()=>{
 const f=fragment(entity()),loaded=await request(`/api/memory/pipeline/fragments/${f.id}/source-review`);
 db.prepare("UPDATE memory_fragment_provenance SET kind='interaction_pattern' WHERE fragment_id=?").run(f.id);
 const response=await request(`/api/memory/pipeline/fragments/${f.id}/source-review`,{version:loaded.body.version,memory_kind:'user_fact',evidence:[{message_id:JSON.parse(f.source_msg_ids)[0],quote:f.content}]});
 assert.equal(response.status,409);
});
test('real browse tool observes masked profiles and rejected ownership, while retaining topic browsing',async()=>{
 const browse=require('../services/tools/memoryTools').find(t=>t.name==='browse_memories');
 const owner=entity('person','Fixture Browse Owner'),topic=entity('test_aggregate','Fixture Browse Topic'),f=fragment(owner);
 db.prepare("UPDATE entity_profiles SET facts='UNSUPPORTED_PROFILE_FIELD' WHERE id=?").run(owner);
 db.prepare("UPDATE fragment_entities SET relation='rejected',classified_by='manual_verified',confidence=0 WHERE fragment_id=? AND entity_id=?").run(f.id,owner);
 links.writeLink(db,f.id,topic,'topic',0.85,'tag_routing');
 const hidden=await browse.handler({path:'Fixture Browse Owner'},{}),visible=await browse.handler({path:'Fixture Browse Topic'},{});
 assert.doesNotMatch(hidden.formatted,/UNSUPPORTED_PROFILE_FIELD|Fixture statement/);
 assert.match(visible.formatted,/Fixture statement/);
});
test('real consolidation commits lineage before vector failure and consumes only covered sources',async()=>{
 const archivist=require('../services/archivist'),owner=entity('event','Fixture Consolidation Owner');
 const frags=Array.from({length:15},()=>fragment(owner));
 assert.equal(db.prepare('SELECT fragment_count FROM entity_profiles WHERE id=?').get(owner).fragment_count,15);
 const originalIndex=memory.chromaDBOperation;
 memory.chromaDBOperation=async()=>{throw Error('fixture_vector_unavailable');};
 llmReply=async(_messages,system)=>({reply:system?.includes('星座记忆整合器')?JSON.stringify({clusters:[{...output([0,1,2],[0]),merged_memory:'Fixture consolidation records one gallery visit with bounded partial source coverage.'}]}):'{"entries":[]}'});
 try {await archivist.consolidateCategory();}finally{memory.chromaDBOperation=originalIndex;}
 const row=db.prepare('SELECT * FROM memories WHERE entity_id=? AND content LIKE ?').get(owner,'Fixture consolidation%');
 assert.ok(row);assert.equal(row.chroma_id,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_fragment_sources WHERE memory_id=?').get(row.id).n,3);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_fragments WHERE status='active' AND id IN ("+frags.map(()=>'?').join(',')+')').get(...frags.map(f=>f.id)).n,14);
 const source=fragment(owner);
 db.prepare('INSERT INTO memory_derivation_reviews(target_type,target_id,reason) VALUES(?,?,?)').run('episode',row.id,'fixture_manual_review');
 const replaced=await request('/api/memory/pipeline/reviews/episode/'+row.id,{revision:integrity.revision(db,'episode',row.id),action:'replace',fragment_ids:[source.id],values:{content:'Reviewed replacement fixture episode.'}});
 assert.equal(replaced.status,200);
 assert.deepEqual(JSON.parse(db.prepare('SELECT source_msg_ids FROM memories WHERE id=?').get(row.id).source_msg_ids),JSON.parse(source.source_msg_ids));
});
test('real cron registration invokes production stage wrappers and registers only once',async()=>{
 const cron=require('node-cron'),schedule=cron.schedule,callbacks=[];
 cron.schedule=(expression,callback)=>{callbacks.push({expression,callback});return {stop(){}};};
 const modulePath=require.resolve('../tasks/cron');delete require.cache[modulePath];
 try {
  const {registerCronJobs}=require('../tasks/cron');registerCronJobs();registerCronJobs();
  assert.equal(callbacks.length,3);
  callbacks.find(c=>c.expression==='*/5 * * * *').callback();
  await new Promise(r=>setImmediate(r));
  assert.ok(db.prepare("SELECT last_started_at FROM memory_pipeline_runs WHERE stage='scribe'").get().last_started_at);
  assert.ok(db.prepare("SELECT last_success_at FROM memory_pipeline_runs WHERE stage='archivist_start'").get().last_success_at);
 } finally {cron.schedule=schedule;require('../services/archivist').stop();}
});
