'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-constellations-ingest-'));
process.env.DB_PATH = path.join(tmpDir, 'ingest.sqlite');
process.env.SANCTUARY_ENCRYPTION_KEY ||= '11'.repeat(32);

const { initDatabase } = require('../database');
const { ingestMessages } = require('../routes/ingest');

const db = initDatabase();

function invoke(body) {
    const response = {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
    ingestMessages({ body }, response);
    return response;
}

try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chats').get().count, 0);

    const first = invoke({ chat_id: 1, sender: 'user', content: 'Synthetic first message' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.payload, { success: true, count: 1, chat_id: 1 });
    assert.equal(db.prepare('SELECT name FROM chats WHERE id=1').get().name, 'Ingest 1');
    assert.equal(db.prepare('SELECT chat_id FROM messages').get().chat_id, 1);

    db.prepare("INSERT INTO chats(id,name) VALUES(7,'Existing chat')").run();
    const existing = invoke({ chat_id: 7, sender: 'assistant', content: 'Synthetic reply' });
    assert.equal(existing.statusCode, 200);
    assert.equal(db.prepare('SELECT name FROM chats WHERE id=7').get().name, 'Existing chat');

    const invalid = invoke({ chat_id: 0, sender: 'user', content: 'Rejected input' });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.payload.error, /正整数/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);

    const archivistSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'archivist.js'), 'utf8');
    const aggregateStart = archivistSource.indexOf("runTaskIfDue('aggregateLink'");
    const aggregateEnd = archivistSource.indexOf('MIN_GAP_AUTO_LINK);', aggregateStart);
    assert.ok(aggregateStart >= 0 && aggregateEnd > aggregateStart, 'aggregateLink task must exist');
    const aggregateTask = archivistSource.slice(aggregateStart, aggregateEnd);
    assert.match(aggregateTask, /linkTaggedFragments\(getDb\(\)\)/);
    assert.doesNotMatch(aggregateTask, /linkTaggedFragments\(db\)/);

    console.log('ingest contracts: ok');
} finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
