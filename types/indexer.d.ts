// Types for veridic/indexer (core/indexer.mjs): finding, building and refreshing the code index.
export function findCodegraph(): string | null;
export function ensureIndex(repo: string, opts?: { build?: boolean; sync?: boolean; log?: (s: string) => void }): unknown;
export function freshIndex(repo: string): unknown;
export function indexLag(repo: string): unknown;
