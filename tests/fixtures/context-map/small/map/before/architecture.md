# Architecture

## Layers

| Layer | Module |
| --- | --- |
| admission | `src/gateway.ts` |
| persistence | `src/store.ts` |

- The gateway admits requests.
- The store applies mutations.
