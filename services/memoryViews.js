// Read contracts: raw rows remain available for maintenance, runtime readers use views.
const { gate } = require('./memoryIntegrity');
const { evidenceSQL,associationSQL } = require('./memoryLinks');
const PROFILE_FIELDS=new Set(['overview','talking_points','facts','current_status','judgment','mbti','location','occupation','age_text','gender',
    'relationship_to_user','relationship_nature','emotional_significance','relationship_category','relationship_confidence','birthday','structured_facts','status_since']);
function installViews(db) {
    const columns=db.prepare('PRAGMA table_info(entity_profiles)').all();
    const profile=columns.map(({name})=>PROFILE_FIELDS.has(name)
        ? `CASE WHEN ${gate('profile','ep.id')} THEN ep."${name}" ELSE NULL END AS "${name}"`
        : `ep."${name}"`).join(',');
    db.exec(`
      CREATE VIEW IF NOT EXISTS memory_entity_evidence AS SELECT fe.* FROM fragment_entities fe WHERE ${evidenceSQL()};
      CREATE VIEW IF NOT EXISTS memory_entity_associations AS SELECT fe.* FROM fragment_entities fe WHERE ${associationSQL()};
      CREATE VIEW IF NOT EXISTS memory_visible_profiles AS SELECT ${profile},NOT ${gate('profile','ep.id')} AS needs_source_review FROM entity_profiles ep;
      CREATE VIEW IF NOT EXISTS memory_valid_episodes AS SELECT m.* FROM memories m WHERE ${gate('episode','m.id')};
      CREATE VIEW IF NOT EXISTS memory_valid_user_model AS SELECT cm.* FROM user_model cm WHERE ${gate('user_model','cm.id')};
      CREATE VIEW IF NOT EXISTS memory_valid_patterns AS SELECT p.* FROM user_patterns p WHERE ${gate('pattern','p.id')};
      CREATE VIEW IF NOT EXISTS memory_valid_sagas AS SELECT s.* FROM memory_sagas s WHERE ${gate('saga','s.id')};
      CREATE VIEW IF NOT EXISTS memory_visible_fragments AS SELECT f.* FROM memory_fragments f
        WHERE NOT EXISTS(SELECT 1 FROM memory_fragment_provenance p WHERE p.fragment_id=f.id AND p.state!='quoted');
    `);
}
module.exports={installViews,PROFILE_FIELDS};
