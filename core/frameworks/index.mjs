// The framework adapters, in order: each finds its framework's routes (see routes.mjs).
import express from "./express.mjs";
import nextjs from "./nextjs.mjs";

export const adapters = [express, nextjs];

/** The idioms of the framework a route comes from (Express's when it doesn't say). */
export const idiomsOf = (route) => (adapters.find((a) => a.name === route?.framework) ?? express).idioms;
