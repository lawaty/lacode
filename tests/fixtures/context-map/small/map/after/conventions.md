# Conventions

- [binding] Read the owning page before changing a boundary. — See `docs/DESIGN.md` §The two halves (verified 2026-10-26)
- [binding] Never bypass the store for a mutation. — See `src/store.ts` (verified 2026-10-26)
- [binding] Keep the gateway free of durable state. — See `src/gateway.ts` (verified 2026-10-26)
