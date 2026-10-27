// Types for veridic/staleness (core/staleness.mjs): which cited lines a change touched.
export type Hunk = { a: number; b: number; c: number; d: number; header: string };
export type FileChange = { old: string; new: string; status: "modified" | "added" | "deleted" | "renamed"; hunks: Hunk[] };
export function parseDiff(text: string): Map<string, FileChange>;
export function touches(h: Hunk, start: number, end: number): boolean;
export function shiftLine(hunks: Hunk[], n: number): number;
export function staleness(repo: string, spec: string, opts?: { range?: string; bases?: string[] }): unknown;
