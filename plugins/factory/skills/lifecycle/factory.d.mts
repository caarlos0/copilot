// Types for old importers of factory.mjs (serve.mjs and the tests). The dispatcher bundle wraps the
// writer in a lazy init, so TypeScript cannot infer these exports from the generated file.
export class ConflictError extends Error {}
export function update(file: string, writes: Record<string, any>, options?: Record<string, any>): Promise<any>;
export function main(argv: string[]): Promise<void>;
