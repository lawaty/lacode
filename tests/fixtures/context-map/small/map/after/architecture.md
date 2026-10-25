# Architecture

- [binding] The system is split into a gateway and a store because the gateway must stay stateless. — See `docs/DESIGN.md` §The two halves (verified 2026-10-26)
- [binding] The gateway is the only admission point. — See `src/gateway.ts` (verified 2026-10-26)
- [binding] The store is the only writer of durable state. — See `src/store.ts` (verified 2026-10-26)
- [binding] The two halves communicate through the store boundary, not by importing internals. — See `docs/DESIGN.md` §The two halves (verified 2026-10-26)
