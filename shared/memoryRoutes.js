(function exposeMemoryRoutes(root, factory) {
    const routes = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = routes;
    }
    if (root) {
        root.MemoryRoutes = routes;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildMemoryRoutes() {
    const BASE = '/api/memory';
    const segment = value => encodeURIComponent(String(value));

    const routes = {
        memory: BASE,
        memoryItem: id => `${BASE}/${segment(id)}`,
        memoryItemPattern: `${BASE}/:id`,
        universe: `${BASE}/universe`,
        pipelineStatus: `${BASE}/pipeline-status`,
        coreInsight: `${BASE}/core-insight`,
        unlinkFragment: `${BASE}/unlink-fragment`,
        trace: fragmentId => `${BASE}/trace/${segment(fragmentId)}`,
        tracePattern: `${BASE}/trace/:fragmentId`,
        mergeProposal: proposalId => `${BASE}/merge-proposal/${segment(proposalId)}`,
        mergeProposalPattern: `${BASE}/merge-proposal/:id`,
    };

    return Object.freeze(routes);
}));
