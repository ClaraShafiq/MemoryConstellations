// Upgrade an actual previous public schema; never opens a user's database.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'constellations-upgrade-'));
process.env.DB_PATH=path.join(dir,'legacy.db');
process.env.SANCTUARY_ENCRYPTION_KEY=require('node:crypto').randomBytes(32).toString('hex');
const root=path.join(__dirname,'..'),filename=path.join(root,'database.js');
const previous=new Module(filename,module);previous.filename=filename;previous.paths=Module._nodeModulePaths(root);
previous._compile(execFileSync('git',['show','e6900bf:database.js'],{cwd:root,encoding:'utf8'}),filename);
const old=previous.exports.initDatabase();
old.exec(`INSERT INTO entity_profiles(id,name,category,facts,status) VALUES(900,'Legacy Fixture','person','Preserved legacy wording','active');
INSERT INTO memory_fragments(id,type,entity,content,source_date,source_msg_ids,status) VALUES(900,'event','','Legacy fixture statement','2026-10-01','[]','active');
INSERT INTO fragment_entities(fragment_id,entity_id,relation,confidence,classified_by) VALUES(900,900,'direct',0.8,'scribe_extract');
INSERT INTO memories(id,title,content,layer,status,entity_id) VALUES(900,'Legacy fixture','Legacy event without lineage','episode','permanent',900);`);
old.close();const db=require('../database').initDatabase();
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('previous public schema upgrades atomically and preserves originals without fabricated quotes',()=>{
 assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version=104').get());
 assert.equal(db.prepare('SELECT facts FROM entity_profiles WHERE id=900').get().facts,'Preserved legacy wording');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_fragment_provenance WHERE fragment_id=900').get().n,0);
 assert.equal(db.prepare('SELECT facts FROM memory_visible_profiles WHERE id=900').get().facts,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_valid_episodes WHERE id=900').get().n,0);
 assert.ok(require('../services/memoryOperations').assertContracts(db).contracts_ready);
});
test('real FTS triggers update and delete precisely the affected synthetic row',()=>{
 db.prepare("UPDATE memory_fragments SET content='UniqueFixtureReplacement' WHERE id=900").run();
 assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_fragments_fts WHERE memory_fragments_fts MATCH 'UniqueFixtureReplacement' AND rowid=900").get().n,1);
 db.prepare('DELETE FROM fragment_entities WHERE fragment_id=900').run();
 db.prepare('DELETE FROM memory_fragments WHERE id=900').run();
 assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_fragments_fts WHERE memory_fragments_fts MATCH 'UniqueFixtureReplacement' AND rowid=900").get().n,0);
});
test('missing runtime view is a startup contract failure, not healthy degradation',()=>{
 assert.throws(()=>db.transaction(()=>{db.exec('DROP VIEW memory_visible_profiles');assert.throws(()=>require('../services/memoryOperations').assertContracts(db),/memory_visible_profiles/);throw Error('rollback');})(),/rollback/);
});
