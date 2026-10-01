import { effect } from "@preact/signals-core";
import Y from "yoga-layout";
import { inputManager } from "../core/input.ts";
import { Terminal } from "../core/terminal.ts";
import { ElementType, getElement } from "./elements/index.ts";
import { clearPendingCursor, getPendingCursor } from "./elements/text-input.ts";
import {
	clearCurrentStore,
	createHookStore,
	disposeHookStore,
	type HookStore,
	setCurrentStore,
} from "./hooks/signals.ts";
import { Fragment, type VNode } from "./jsx-runtime.ts";
import type { Instance, Position, RenderContext } from "./types/index.ts";

interface ReconcileCtx {
	oldChildren: Instance[];
	nextIndex: number;
	oldKeyMap: Map<string | number, number>;
	consumed: Set<number>;
}

export class Renderer {
	terminal: Terminal;
	rootInstance: Instance | null = null;
	disposeEffect: (() => void) | null = null;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	renderInstance(instance: Instance, parentX = 0, parentY = 0): Position[] {
		const context: RenderContext = {
			parentX: Math.round(parentX),
			parentY: Math.round(parentY),
			renderInstance: this.renderInstance.bind(this),
		};

		const { render } = getElement(instance.type);
		return render(instance, context);
	}

	freeYogaNodes(instance: Instance) {
		for (const child of instance.children) {
			this.freeYogaNodes(child);
		}
		if (instance.hookStore) {
			disposeHookStore(instance.hookStore);
		}
		instance.yogaNode.free();
	}

	// --- Mount path: create fresh instances from VNodes ---

	mountInstance(vnode: VNode, hookStore?: HookStore): Instance {
		if (typeof vnode.type === "function") {
			const store = hookStore ?? createHookStore();
			setCurrentStore(store);
			while (typeof vnode.type === "function") {
				vnode = (vnode.type as any)(vnode.props);
			}
			clearCurrentStore();
			const instance = this.mountInstance(vnode);
			instance.hookStore = store;
			return instance;
		}

		if (vnode.type === "fragment") {
			return this.mountInstance({ type: ElementType.BOX, props: { children: vnode.props.children } });
		}

		const type = typeof vnode.type === "string" ? vnode.type : ElementType.BOX;
		const element = getElement(type);

		const instance = {
			type,
			props: vnode.props,
			children: [] as Instance[],
			yogaNode: Y.Node.create(),
		} as Instance;

		element.layout(instance);

		if (element.hasChildren) {
			const rawChildren = Array.isArray(vnode.props.children)
				? vnode.props.children
				: [vnode.props.children].filter(Boolean);

			for (const child of rawChildren.flat(Infinity)) {
				this.mountChild(child, instance);
			}
		}

		return instance;
	}

	private mountChild(child: unknown, parent: Instance) {
		if (typeof child === "string" || typeof child === "number") {
			const textElement = getElement(ElementType.TEXT);
			const childInstance: Instance = {
				type: ElementType.TEXT,
				props: { children: child.toString() },
				children: [],
				yogaNode: Y.Node.create(),
			};
			textElement.layout(childInstance);
			parent.children.push(childInstance);
			parent.yogaNode.insertChild(childInstance.yogaNode, parent.children.length - 1);
			return;
		}

		if (!child || typeof child !== "object" || !(child as VNode).type) return;

		let vnode = child as VNode;
		if (typeof vnode.type === "function") {
			const componentType = vnode.type;
			const store = createHookStore();
			setCurrentStore(store);
			while (typeof vnode.type === "function") {
				vnode = (vnode.type as any)(vnode.props);
			}
			clearCurrentStore();

			if (vnode.type === "fragment") {
				const rawChildren = Array.isArray(vnode.props.children)
					? vnode.props.children
					: [vnode.props.children].filter(Boolean);
				for (const c of rawChildren.flat(Infinity)) {
					this.mountChild(c, parent);
				}
				return;
			}

			const childInstance = this.mountInstance(vnode);
			childInstance.componentType = componentType;
			childInstance.hookStore = store;
			parent.children.push(childInstance);
			parent.yogaNode.insertChild(childInstance.yogaNode, parent.children.length - 1);
			return;
		}

		if (vnode.type === "fragment") {
			const rawChildren = Array.isArray(vnode.props.children)
				? vnode.props.children
				: [vnode.props.children].filter(Boolean);
			for (const c of rawChildren.flat(Infinity)) {
				this.mountChild(c, parent);
			}
			return;
		}

		const childInstance = this.mountInstance(vnode);
		parent.children.push(childInstance);
		parent.yogaNode.insertChild(childInstance.yogaNode, parent.children.length - 1);
	}

	// --- Reconcile path: diff VNode against existing Instance tree ---

	reconcile(vnode: VNode, existing: Instance | null): Instance | null {
		if (typeof vnode.type === "function") {
			const store = existing?.hookStore ?? createHookStore();
			setCurrentStore(store);
			while (typeof vnode.type === "function") {
				const resolved = (vnode.type as any)(vnode.props);
				if (!resolved) {
					clearCurrentStore();
					if (existing) this.freeYogaNodes(existing);
					return null;
				}
				vnode = resolved;
			}
			clearCurrentStore();
			const instance = this.reconcile(vnode, existing);
			if (!instance) return null;
			instance.hookStore = store;
			return instance;
		}

		if (vnode.type === "fragment") {
			return this.reconcile(
				{ type: ElementType.BOX, props: { children: vnode.props.children } },
				existing,
			);
		}

		const type = typeof vnode.type === "string" ? vnode.type : ElementType.BOX;

		if (!existing || existing.type !== type) {
			if (existing) this.freeYogaNodes(existing);
			return this.mountInstance(vnode);
		}

		existing.props = vnode.props;
		const element = getElement(type);
		element.layout(existing);

		if (element.hasChildren) {
			this.reconcileChildren(vnode, existing);
		}

		return existing;
	}

	private reconcileChildren(parentVNode: VNode, parentInstance: Instance) {
		const rawChildren = Array.isArray(parentVNode.props.children)
			? parentVNode.props.children
			: [parentVNode.props.children].filter(Boolean);

		const oldChildren = parentInstance.children;
		const newChildren: Instance[] = [];

		const oldKeyMap = new Map<string | number, number>();
		for (let i = 0; i < oldChildren.length; i++) {
			const child = oldChildren[i];
			if (!child) continue;
			const key = child.props.key;
			if (key !== undefined && key !== null) {
				oldKeyMap.set(key, i);
			}
		}

		const consumed = new Set<number>();
		const ctx: ReconcileCtx = { oldChildren, nextIndex: 0, oldKeyMap, consumed };

		this.resolveAndReconcile(rawChildren.flat(Infinity), ctx, newChildren);

		for (let i = 0; i < oldChildren.length; i++) {
			const child = oldChildren[i];
			if (!consumed.has(i) && child) {
				this.freeYogaNodes(child);
			}
		}

		parentInstance.children = newChildren;

		const childCount = parentInstance.yogaNode.getChildCount();
		for (let i = childCount - 1; i >= 0; i--) {
			parentInstance.yogaNode.removeChild(parentInstance.yogaNode.getChild(i));
		}
		for (let i = 0; i < newChildren.length; i++) {
			const child = newChildren[i];
			if (child) parentInstance.yogaNode.insertChild(child.yogaNode, i);
		}
	}

	private consumeOldChild(ctx: ReconcileCtx, key: string | number | undefined | null): Instance | null {
		if (key !== undefined && key !== null && ctx.oldKeyMap.has(key)) {
			const idx = ctx.oldKeyMap.get(key)!;
			if (!ctx.consumed.has(idx)) {
				ctx.consumed.add(idx);
				return ctx.oldChildren[idx] ?? null;
			}
		}

		while (ctx.nextIndex < ctx.oldChildren.length && ctx.consumed.has(ctx.nextIndex)) {
			ctx.nextIndex++;
		}
		if (ctx.nextIndex < ctx.oldChildren.length) {
			const idx = ctx.nextIndex;
			ctx.consumed.add(idx);
			ctx.nextIndex++;
			return ctx.oldChildren[idx] ?? null;
		}

		return null;
	}

	private resolveAndReconcile(
		children: unknown[],
		ctx: ReconcileCtx,
		newChildren: Instance[],
	) {
		for (const child of children) {
			if (typeof child === "string" || typeof child === "number") {
				const oldChild = this.consumeOldChild(ctx, undefined);
				const text = child.toString();

				if (oldChild && oldChild.type === ElementType.TEXT) {
					const oldText = oldChild.props.children;
					oldChild.props = { children: text };
					const element = getElement(ElementType.TEXT);
					element.layout(oldChild);
					if (oldText !== text && oldChild.props.height === undefined) {
						oldChild.yogaNode.markDirty();
					}
					newChildren.push(oldChild);
				} else {
					if (oldChild) this.freeYogaNodes(oldChild);
					const textElement = getElement(ElementType.TEXT);
					const instance: Instance = {
						type: ElementType.TEXT,
						props: { children: text },
						children: [],
						yogaNode: Y.Node.create(),
					} as Instance;
					textElement.layout(instance);
					newChildren.push(instance);
				}
			} else if (child && typeof child === "object" && (child as VNode).type) {
				let vnode = child as VNode;
				let componentType: unknown;
				let store: HookStore | undefined;

				// Resolve Fragment immediately — it's transparent and its children
				// must share the parent's positional tracking (ctx). Consuming an
				// old child for the Fragment wrapper itself would shift positions
				// and break hookStore matching for children inside it.
				if (vnode.type === Fragment) {
					vnode = Fragment(vnode.props as { children?: VNode | VNode[] });
				}

				if (typeof vnode.type === "function") {
					componentType = vnode.type;
				}

				if (vnode.type === "fragment" || (typeof vnode.type !== "function" && !componentType)) {
					if (vnode.type === "fragment") {
						const fragChildren = Array.isArray(vnode.props.children)
							? vnode.props.children
							: [vnode.props.children].filter(Boolean);
						this.resolveAndReconcile(fragChildren.flat(Infinity), ctx, newChildren);
					} else {
						const key = vnode.props.key;
						const oldChild = this.consumeOldChild(ctx, key);
						const inst = this.reconcile(vnode, oldChild);
						if (inst) newChildren.push(inst);
					}
				} else {
					const key = vnode.props.key;
					const oldChild = this.consumeOldChild(ctx, key);

					if (componentType && oldChild && oldChild.componentType !== componentType) {
						this.freeYogaNodes(oldChild);
						store = createHookStore();
						setCurrentStore(store);
						while (typeof vnode.type === "function") {
							const resolved = (vnode.type as any)(vnode.props);
							if (!resolved) {
								vnode = null as any;
								break;
							}
							vnode = resolved;
						}
						clearCurrentStore();

						if (!vnode) continue;

						if (vnode.type === "fragment") {
							const fragChildren = Array.isArray(vnode.props.children)
								? vnode.props.children
								: [vnode.props.children].filter(Boolean);
							this.resolveAndReconcile(fragChildren.flat(Infinity), ctx, newChildren);
						} else {
							const inst = this.mountInstance(vnode);
							inst.componentType = componentType;
							inst.hookStore = store;
							newChildren.push(inst);
						}
					} else {
						store = oldChild?.hookStore ?? createHookStore();
						setCurrentStore(store);
						while (typeof vnode.type === "function") {
							const resolved = (vnode.type as any)(vnode.props);
							if (!resolved) {
								vnode = null as any;
								break;
							}
							vnode = resolved;
						}
						clearCurrentStore();

						if (!vnode) {
							if (oldChild) this.freeYogaNodes(oldChild);
							continue;
						}

						if (vnode.type === "fragment") {
							const fragChildren = Array.isArray(vnode.props.children)
								? vnode.props.children
								: [vnode.props.children].filter(Boolean);
							this.resolveAndReconcile(fragChildren.flat(Infinity), ctx, newChildren);
						} else {
							const inst = this.reconcile(vnode, oldChild);
							if (inst) {
								if (componentType) inst.componentType = componentType;
								inst.hookStore = store;
								newChildren.push(inst);
							}
						}
					}
				}
			}
		}
	}

	// --- Commit: reconcile or mount, then layout + paint ---

	commitRender(vnode: VNode) {
		clearPendingCursor();

		if (this.rootInstance) {
			this.rootInstance = this.reconcile(vnode, this.rootInstance);
		} else {
			this.rootInstance = this.mountInstance(vnode);
		}

		if (!this.rootInstance) return;

		this.rootInstance.yogaNode.setWidth(this.terminal.width);
		this.rootInstance.yogaNode.setHeight(this.terminal.height);
		this.rootInstance.yogaNode.calculateLayout(this.terminal.width, this.terminal.height, Y.DIRECTION_LTR);

		this.terminal.beginFrame();
		this.terminal.render(this.renderInstance(this.rootInstance, 0, 0));

		const cursor = getPendingCursor();
		if (cursor?.visible) {
			this.terminal.setCursorPosition(cursor.x, cursor.y);
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
		this.terminal.endFrame();
	}

	render(createVNode: () => VNode) {
		this.disposeEffect = effect(() => {
			this.commitRender(createVNode());
		});
	}

	unmount() {
		if (this.disposeEffect) {
			this.disposeEffect();
			this.disposeEffect = null;
		}
		if (this.rootInstance) {
			this.freeYogaNodes(this.rootInstance);
			this.rootInstance = null;
		}
		this.terminal.dispose();
	}
}

export function render(createVNode: () => VNode, terminal: Terminal) {
	const renderer = new Renderer(terminal);
	renderer.render(createVNode);
	return {
		rerender: () => renderer.render(createVNode),
		unmount: () => renderer.unmount(),
	};
}

export function run(createVNode: (quit: () => void) => VNode, onBeforeQuit?: () => void | Promise<void>) {
	const terminal = new Terminal();

	const quit = async () => {
		if (onBeforeQuit) await onBeforeQuit();
		cleanupKey();
		inputManager.stop();
		unmount();
		// Flush teardown bytes (exit-alternate-screen) before killing the
		// process — Deno.exit() drops queued stdout writes otherwise.
		await terminal.drain().catch(() => {});
		Deno.exit(0);
	};

	const { unmount } = render(() => createVNode(quit), terminal);

	inputManager.start();

	const cleanupKey = inputManager.onKeyGlobal((event) => {
		if (event.ctrl && event.key === "c") {
			quit();
		}
		return false;
	});

	return { unmount, terminal };
}
