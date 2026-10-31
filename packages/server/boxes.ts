import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import type { HttpServerResponse } from "effect/http";
import { resolveProjectBoxSettings } from "@vvtxn/box/config.ts";
import { isBoxProfile, profileRank, profileResources } from "@vvtxn/box/profiles.ts";
import type { BoxSettings, BoxStatus } from "@vvtxn/box/types.ts";
import { validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import type {
	BoxAttachRequest,
	BoxListResponse,
	BoxProfileName,
	BoxResizeRequest,
	BoxResponse,
	BoxSyncResponse,
	CreateBoxRequest,
	StatusResponse,
} from "@vvtxn/client/protocol.ts";
import { boxSummary } from "./box-summary.ts";
import { BadRequestError, error, ForbiddenError, json, NotFoundError, readJsonBody } from "./http.ts";
import type { RequestServices } from "./services.ts";
import { openSessionHandle } from "./sessions.ts";

function ownedBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<BoxStatus, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		const status = yield* services.boxes
			.status(boxId)
			.pipe(Effect.catchTag("BoxError", (boxError) => Effect.fail(new Error(boxError.message))));
		if (!status) return yield* Effect.fail(new NotFoundError(`No box found: ${boxId}`));
		if (status.ownerId !== services.user.id) {
			return yield* Effect.fail(new ForbiddenError("This box belongs to another user"));
		}
		return status;
	});
}

function boxFailure(errorValue: { message: string }): HttpServerResponse.HttpServerResponse {
	return error(409, errorValue.message);
}

export function handleCreateBox(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		const body = (yield* readJsonBody<CreateBoxRequest>(request)) ?? {};
		const rawCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : services.config.defaultCwd;
		const workspace = yield* Effect.tryPromise({
			try: () => validateWorkspacePath(rawCwd, services.config.workspaceRoots),
			catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
		});
		if (!workspace.ok) {
			const ErrorClass = workspace.reason === "outside-roots" ? ForbiddenError : BadRequestError;
			return yield* Effect.fail(new ErrorClass(workspace.message));
		}
		const base = yield* Effect.tryPromise({
			try: () => resolveProjectBoxSettings(workspace.path, services.config.box.defaults),
			catch: (cause) => new BadRequestError(cause instanceof Error ? cause.message : String(cause)),
		});
		let settings: BoxSettings = base;
		const requested = body.profile;
		if (requested !== undefined) {
			if (!isBoxProfile(requested)) {
				return yield* Effect.fail(new BadRequestError('"profile" must be "tiny", "small", or "medium"'));
			}
			if (profileRank(requested) > profileRank(base.maxProfile)) {
				return yield* Effect.fail(new BadRequestError(`This project allows at most ${base.maxProfile}`));
			}
			const resources = profileResources(requested);
			settings = {
				...base,
				profile: requested,
				cpus: resources.cpus,
				memoryMiB: resources.memoryMiB,
				rootDiskMiB: Math.max(base.rootDiskMiB, resources.rootDiskMiB),
			};
		}
		const status = yield* services.boxes
			.create({
				ownerId: services.user.id,
				projectCwd: workspace.path,
				settings,
			})
			.pipe(Effect.catchTag("BoxError", (boxError) => Effect.fail(new BadRequestError(boxError.message))));
		return json({ box: boxSummary(status) } satisfies BoxResponse, 201);
	});
}

export function handleListBoxes(
	services: RequestServices,
): Effect.Effect<HttpServerResponse.HttpServerResponse, Error> {
	return Effect.gen(function* () {
		const boxes = yield* services.boxes
			.list(services.user.id)
			.pipe(Effect.catchTag("BoxError", (boxError) => Effect.fail(new Error(boxError.message))));
		return json({
			boxes: boxes.map((box) => boxSummary(box)),
		} satisfies BoxListResponse);
	});
}

export function handleGetBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		const box = yield* ownedBox(services, boxId);
		return json({ box: boxSummary(box) } satisfies BoxResponse);
	});
}

export function handleAttachBox(
	services: RequestServices,
	boxId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		const owned = yield* ownedBox(services, boxId);
		const body = yield* readJsonBody<BoxAttachRequest>(request);
		if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
			return yield* Effect.fail(new BadRequestError('"sessionId" is required'));
		}
		// Opening the session verifies ownership before a box is attached to it.
		const session = yield* openSessionHandle(services, body.sessionId);
		if (owned.projectCwd !== session.getHeader().cwd) {
			return yield* Effect.fail(new BadRequestError("This box belongs to a different workspace"));
		}
		const box = yield* services.boxes
			.attach(boxId, body.sessionId)
			.pipe(Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))));
		return "boxId" in box ? json({ box: boxSummary(box) } satisfies BoxResponse) : box;
	});
}

export function handleDetachBox(
	services: RequestServices,
	boxId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		const body = yield* readJsonBody<BoxAttachRequest>(request);
		if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
			return yield* Effect.fail(new BadRequestError('"sessionId" is required'));
		}
		return yield* services.boxes.detach(boxId, body.sessionId).pipe(
			Effect.map(() => json({ status: "ok" } satisfies StatusResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handleResizeBox(
	services: RequestServices,
	boxId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		const body = yield* readJsonBody<BoxResizeRequest>(request);
		if (!body || !isBoxProfile(body.profile)) {
			return yield* Effect.fail(new BadRequestError('"profile" must be "tiny", "small", or "medium"'));
		}
		const profile: BoxProfileName = body.profile;
		return yield* services.boxes.resize(boxId, profile).pipe(
			Effect.map((box) => json({ box: boxSummary(box) } satisfies BoxResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handleSyncBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		return yield* services.boxes.sync(boxId).pipe(
			Effect.map((result) => json(result satisfies BoxSyncResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handlePauseBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		return yield* services.boxes.pause(boxId).pipe(
			Effect.map(() => json({ status: "ok" } satisfies StatusResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handleResumeBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		return yield* services.boxes.resume(boxId).pipe(
			Effect.map(() => json({ status: "ok" } satisfies StatusResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handleStopBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		yield* ownedBox(services, boxId);
		return yield* services.boxes.stop(boxId).pipe(
			Effect.map(() => json({ status: "ok" } satisfies StatusResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}

export function handleRemoveBox(
	services: RequestServices,
	boxId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError | ForbiddenError | Error> {
	return Effect.gen(function* () {
		const box = yield* ownedBox(services, boxId);
		for (const attachment of box.attachments) {
			const detached = yield* services.boxes.detach(boxId, attachment.sessionId).pipe(
				Effect.map(() => ({ ok: true as const })),
				Effect.catchTag("BoxError", (boxError) =>
					Effect.succeed({ ok: false as const, response: boxFailure(boxError) }),
				),
			);
			if (!detached.ok) return detached.response;
		}
		return yield* services.boxes.destroy(boxId).pipe(
			Effect.map(() => json({ status: "ok" } satisfies StatusResponse)),
			Effect.catchTag("BoxError", (boxError) => Effect.succeed(boxFailure(boxError))),
		);
	});
}
