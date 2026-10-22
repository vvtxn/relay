import { startServer } from "./main.ts";

// Separate entry so importing `main.ts` (the CLI does) never starts a server
// as a module side effect. Bundlers cannot reliably preserve `import.meta.main`
// across a SEA bundle.
await startServer();
