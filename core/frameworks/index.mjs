// The framework adapters, in order: each finds its framework's routes (see routes.mjs).
import express from "./express.mjs";

export const adapters = [express];
