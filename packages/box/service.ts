import { Context, Effect, Layer } from "effect";
import { createBoxManager } from "./manager.ts";
import type { BoxManager, BoxManagerConfig } from "./types.ts";

/** Effect service wrapping the process-wide box manager. */
export class Boxes extends Context.Service<Boxes, BoxManager>()("relay/box/Boxes") {}

/** Materialize the manager (and its data-dir lock) once for the server process. */
export function boxesLayer(config: BoxManagerConfig): Layer.Layer<Boxes> {
	return Layer.effect(
		Boxes,
		Effect.sync(() => createBoxManager(config)),
	);
}
