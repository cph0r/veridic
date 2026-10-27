// Types for veridic/product (core/product.mjs): the product spec's journeys and guarantees.
export type Product = { title: string | null; summary: string | null; journeys: { id: string; title: string; steps: { text: string; refs: string[] }[] }[]; guarantees: { id: string; text: string; refs: string[] }[] };
export const PRODUCT_SPEC: RegExp;
export function parseProduct(text: string): Product;
