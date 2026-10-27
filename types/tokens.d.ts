// Types for veridic/tokens (core/tokens.mjs): what a UI spec needs from the code.
export function screenFacts(repo: string, file: string, opts?: { routes?: unknown[]; url?: string | null; linked?: unknown }): { file: string; url: string | null; calls: string[]; forms: { fields: { name: string; type: string; required: boolean }[] }[] };
export function designTokens(repo: string): { colors: unknown; fonts: unknown; spacing: unknown; radii: unknown };
