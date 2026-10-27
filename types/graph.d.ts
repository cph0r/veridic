// Types for veridic/graph (core/graph.mjs): the code index, read-only.
export type GraphNode = { id: string; kind: string; name: string; qname: string | null; file: string; start: number; end: number };
export type Use = { source: GraphNode; target: GraphNode; kind: "calls" | "references" | "instantiates"; line: number };
export type Graph = {
  repo: string;
  dbPath: string;
  nodes: Map<string, GraphNode>;
  nodesByFile: Map<string, GraphNode[]>;
  files: string[];
  text: (file: string) => string | null;
  lines: (file: string) => string[] | null;
  usesInRange: (file: string, start: number, end: number) => Use[];
  usersOf: (node: GraphNode) => { node: GraphNode; file: string; line: number }[];
  inDegree: (node: GraphNode) => number;
  enclosing: (file: string, line: number) => GraphNode | null;
  close: () => void;
};
export const USE_KINDS: Set<string>;
export const SYMBOL_KINDS: Set<string>;
export function isTestFile(file: string): boolean;
export function openGraph(repo: string): Graph;
