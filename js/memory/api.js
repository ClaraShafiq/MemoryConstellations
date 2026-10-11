const routes = globalThis.MemoryRoutes;

if (!routes) {
    throw new Error('MemoryRoutes contract was not loaded before the memory UI');
}

export const MEMORY_API = routes;
