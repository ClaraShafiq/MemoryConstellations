"""
ChromaDB + Embedding 常驻服务 (FastAPI)
取代每次 spawn 新进程，模型只加载一次，内存复用。

启动：venv/bin/python -m uvicorn chroma_service:app --host 127.0.0.1 --port 7707
PM2:  pm2 start chroma_service.py --name chroma-service --interpreter venv/bin/python
"""

import json
import chromadb
from fastapi import FastAPI
from pydantic import BaseModel
from contextlib import asynccontextmanager

# ── 全局状态（进程生命周期内复用）──
_embed_model = None
_chroma_client = None

def get_embed_model():
    global _embed_model
    if _embed_model is None:
        from fastembed import TextEmbedding
        _embed_model = TextEmbedding(model_name='jinaai/jina-embeddings-v2-base-zh')
    return _embed_model

def get_collection(name='memories_collection'):
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path="./chroma_data")
    return _chroma_client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"}
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时预热模型
    get_embed_model()
    get_collection()
    yield

app = FastAPI(lifespan=lifespan)


# ── 请求体 ──
class AddRequest(BaseModel):
    id: str
    embedding: list
    metadata: dict | None = {}
    collection_name: str | None = 'memories_collection'

class UpsertRequest(BaseModel):
    id: str
    embedding: list
    metadata: dict | None = {}
    collection_name: str | None = 'memories_collection'

class UpdateRequest(BaseModel):
    id: str
    embedding: list
    metadata: dict | None = {}
    collection_name: str | None = 'memories_collection'

class DeleteRequest(BaseModel):
    id: str
    collection_name: str | None = 'memories_collection'

class QueryRequest(BaseModel):
    embedding: list
    n_results: int = 3
    query_text: str = ''
    min_similarity: float = 0.20
    collection_name: str | None = 'memories_collection'

class EmbedRequest(BaseModel):
    text: str

class EmbedBatchRequest(BaseModel):
    texts: list

class IndexBatchRequest(BaseModel):
    items: list  # [{id, text, metadata}, ...]
    dup_threshold: float = 0.85
    collection_name: str | None = 'memories_collection'

class ResetCollectionRequest(BaseModel):
    collection_name: str | None = 'memories_collection'

class FindSimilarGroupsRequest(BaseModel):
    items: list  # [{id, text}, ...]
    n_results: int = 5
    min_similarity: float = 0.82
    collection_name: str | None = 'memories_collection'

class FindDuplicatesRequest(BaseModel):
    items: list  # [{id, text}, ...]
    threshold: float = 0.85
    collection_name: str | None = 'memories_collection'

class QueryMultiItem(BaseModel):
    collection_name: str
    embedding: list
    n_results: int = 3
    min_similarity: float = 0.15
    query_text: str = ''

class QueryMultiRequest(BaseModel):
    queries: list  # list of QueryMultiItem dicts


# ── 路由（逻辑完全从 chroma_helper.py 搬移）──

@app.post("/add")
def api_add(req: AddRequest):
    col = get_collection(req.collection_name)
    col.add(ids=[req.id], embeddings=[req.embedding], metadatas=[req.metadata])
    return {"success": True, "id": req.id}

@app.post("/upsert")
def api_upsert(req: UpsertRequest):
    col = get_collection(req.collection_name)
    col.upsert(ids=[req.id], embeddings=[req.embedding], metadatas=[req.metadata])
    return {"success": True, "id": req.id, "upserted": True}

@app.post("/update")
def api_update(req: UpdateRequest):
    col = get_collection(req.collection_name)
    existing = col.get(ids=[req.id])
    if existing and existing['ids']:
        col.delete(ids=[req.id])
    col.add(ids=[req.id], embeddings=[req.embedding], metadatas=[req.metadata])
    return {"success": True, "id": req.id}

@app.post("/delete")
def api_delete(req: DeleteRequest):
    col = get_collection(req.collection_name)
    existing = col.get(ids=[req.id])
    if existing and existing['ids']:
        col.delete(ids=[req.id])
        return {"success": True, "deleted": True}
    return {"success": True, "deleted": False, "message": "ID not found"}

@app.post("/query")
def api_query(req: QueryRequest):
    col = get_collection(req.collection_name)
    n = req.n_results
    raw = col.query(
        query_embeddings=[req.embedding],
        n_results=max(n * 3, 30),  # 补偿陈旧碎片占位，让新条目有机会进池
        include=['metadatas', 'distances']
    )

    # 过滤和加权（与原 chroma_helper 一致）
    filtered = {'ids': [[]], 'distances': [[]], 'metadatas': [[]]}
    for i in range(len(raw['ids'][0])):
        distance = raw['distances'][0][i]
        similarity = 1 - distance
        metadata = raw['metadatas'][0][i]

        if req.query_text and metadata.get('tags'):
            try:
                tag_list = json.loads(metadata['tags'])
                query_words = [w.strip() for w in req.query_text.replace('，', ',').split() if w.strip()]
                if any(word in tag_list for word in query_words):
                    similarity = min(similarity * 2.0, 1.0)
            except: pass

        if similarity >= req.min_similarity:
            filtered['ids'][0].append(raw['ids'][0][i])
            filtered['distances'][0].append(1 - similarity)
            filtered['metadatas'][0].append(metadata)

    return {
        'ids': [filtered['ids'][0][:n]],
        'distances': [filtered['distances'][0][:n]],
        'metadatas': [filtered['metadatas'][0][:n]],
    }

@app.post("/embed")
def api_embed(req: EmbedRequest):
    model = get_embed_model()
    embeddings = list(model.embed([req.text]))
    return {
        "embedding": embeddings[0].tolist(),
        "dim": len(embeddings[0]),
    }

@app.post("/embed_batch")
def api_embed_batch(req: EmbedBatchRequest):
    model = get_embed_model()
    embeddings = list(model.embed(req.texts))
    return {
        "embeddings": [e.tolist() for e in embeddings],
        "dim": len(embeddings[0]) if embeddings else 0,
    }

@app.post("/index_batch")
def api_index_batch(req: IndexBatchRequest):
    model = get_embed_model()
    items = req.items
    if not items:
        return {"success": True, "indexed": 0, "duplicates": []}

    col = get_collection(req.collection_name)
    texts = [item['text'] for item in items]
    ids = [item['id'] for item in items]
    metadatas = [item.get('metadata', {}) for item in items]

    embeddings = list(model.embed(texts))
    emb_list = [e.tolist() for e in embeddings]

    # 去重检查
    duplicates = []
    for i, emb in enumerate(emb_list):
        raw = col.query(query_embeddings=[emb], n_results=3, include=['metadatas', 'distances'])
        for j in range(len(raw['ids'][0])):
            rid = raw['ids'][0][j]
            if rid == ids[i]:
                continue
            sim = 1 - raw['distances'][0][j]
            if sim >= req.dup_threshold:
                other_content = raw['metadatas'][0][j].get('content', '')[:80]
                duplicates.append({
                    'new_id': ids[i],
                    'existing_id': rid,
                    'similarity': round(sim, 4),
                    'new_preview': texts[i][:80],
                    'existing_preview': other_content,
                })
                break

    # 过滤重复项
    dup_new_ids = {d['new_id'] for d in duplicates}
    filtered_ids = [id for id in ids if id not in dup_new_ids]
    filtered_embs = [emb_list[i] for i, id in enumerate(ids) if id not in dup_new_ids]
    filtered_metas = [metadatas[i] for i, id in enumerate(ids) if id not in dup_new_ids]

    if filtered_ids:
        col.add(ids=filtered_ids, embeddings=filtered_embs, metadatas=filtered_metas)

    return {
        "success": True,
        "indexed": len(filtered_ids),
        "skipped_duplicates": len(duplicates),
        "duplicates": duplicates,
    }

@app.post("/reset_collection")
def api_reset_collection(req: ResetCollectionRequest):
    global _chroma_client
    _chroma_client.delete_collection(name=req.collection_name)
    _chroma_client.get_or_create_collection(name=req.collection_name, metadata={"hnsw:space": "cosine"})
    return {"success": True, "message": "Collection reset"}

@app.post("/find_similar_groups")
def api_find_similar_groups(req: FindSimilarGroupsRequest):
    model = get_embed_model()
    items = req.items
    if not items:
        return {'pairs': []}

    col = get_collection(req.collection_name)
    texts = [item['text'] for item in items]
    embeddings = list(model.embed(texts))
    emb_list = [e.tolist() for e in embeddings]

    raw = col.query(
        query_embeddings=emb_list,
        n_results=min(req.n_results + 1, 10),
        include=['distances']
    )

    batch_ids = {item['id'] for item in items}
    pairs = []
    for i, item in enumerate(items):
        ids_row = raw['ids'][i]
        distances = raw['distances'][i]
        for j, rid in enumerate(ids_row):
            if rid == f'fragment_{item["id"]}':
                continue
            sim = 1 - distances[j]
            if sim >= req.min_similarity and rid.startswith('fragment_'):
                try:
                    frag_id = int(rid.replace('fragment_', ''))
                except ValueError:
                    continue
                if frag_id in batch_ids:
                    pairs.append({
                        'fragment_a': item['id'],
                        'fragment_b': frag_id,
                        'similarity': round(sim, 4),
                    })
    return {'pairs': pairs}

@app.post("/find_duplicates")
def api_find_duplicates(req: FindDuplicatesRequest):
    model = get_embed_model()
    col = get_collection(req.collection_name)
    duplicates = []
    for item in req.items:
        emb = list(model.embed([item['text']]))[0]
        raw = col.query(
            query_embeddings=[emb.tolist()],
            n_results=3,
            include=['metadatas', 'distances']
        )
        for i in range(len(raw['ids'][0])):
            rid = raw['ids'][0][i]
            if rid == item['id']:
                continue
            sim = 1 - raw['distances'][0][i]
            if sim >= req.threshold:
                other_content = raw['metadatas'][0][i].get('content', '')[:60]
                duplicates.append({
                    'new_id': item['id'],
                    'existing_id': rid,
                    'similarity': round(sim, 4),
                    'new_preview': item['text'][:60],
                    'existing_preview': other_content,
                })
                break
    return {'duplicates': duplicates}

@app.post("/query_multi")
def api_query_multi(req: QueryMultiRequest):
    all_results = []
    for q in req.queries:
        col = get_collection(q.get('collection_name', 'memories_collection'))
        n = q.get('n_results', 3)
        min_sim = q.get('min_similarity', 0.15)
        qtext = q.get('query_text', '')

        raw = col.query(
            query_embeddings=[q['embedding']],
            n_results=min(n * 3, 10),
            include=['metadatas', 'distances']
        )

        filtered_ids, filtered_dists, filtered_metas = [], [], []
        for i in range(len(raw['ids'][0])):
            distance = raw['distances'][0][i]
            similarity = 1 - distance
            metadata = raw['metadatas'][0][i]

            if qtext and metadata.get('tags'):
                try:
                    tag_list = json.loads(metadata['tags'])
                    query_words = [w.strip() for w in qtext.replace('，', ',').split() if w.strip()]
                    if any(word in tag_list for word in query_words):
                        similarity = min(similarity * 2.0, 1.0)
                except: pass

            if similarity >= min_sim:
                filtered_ids.append(raw['ids'][0][i])
                filtered_dists.append(1 - similarity)
                filtered_metas.append(metadata)

        all_results.append({
            'collection_name': q.get('collection_name', 'memories_collection'),
            'ids': filtered_ids[:n],
            'distances': filtered_dists[:n],
            'metadatas': filtered_metas[:n],
        })

    return {'results': all_results}


# ── 健康检查 ──
@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _embed_model is not None}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=7707)
