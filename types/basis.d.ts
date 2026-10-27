// Types for veridic/basis (core/basis.mjs): a digest of the exact file contents a result came from.
export function basisOf(repo: string, files: string[]): { digest: string; files: number };
export function basisComment(b: { digest: string; files: number }): string;
export function recordedBasis(text: string): { digest: string; files: number } | null;
