import { effect } from "@preact/signals-core";
import process from "node:process";
import Y from "yoga-layout";
import { inputManager, type KeyEvent } from "../core/input.ts";
import { Terminal, type TerminalOptions } from "../core/terminal.ts";
import { ElementType, getElement } from "./elements/index.ts";
import { scrollbarMetrics, type ScrollbarMetrics, scrollContentHeight } from "./elements/scroll-area.ts";
import { clearPendingCursor, getPendingCursor } from "./elements/text-input.ts";
import {
	clearCurrentStore,
	createHookStore,
	disposeHookStore,
	type HookStore,
	setCurrentStore,
} from "./hooks/signals.ts";
import { Fragment, type VNode } from "./jsx-runtime.ts";
import { isMemoized } from "./memo.ts";
import type { Instance, Position, RenderContext } from "./types/index.ts";

interface ReconcileCtx {
	oldChildren: Instance[];
	nextIndex: number;
	oldKeyMap: Map<string | number, number>;
	consumed: Set<number>;
}

/** Inclusive terminal-cell rectangle used to clip pointer hits inside scroll areas. */
interface ClipRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A hit on a scroll area's bar: painted geometry plus the controlled setter. */
interface ScrollbarTarget {
	metrics: ScrollbarMetrics;
	onChange: (offset: number) => void;
}

/** Result of a hit walk: a clickable instance, or a scrollbar grab. */
interface PointerTarget {
	instance: Instance;
	scrollbar?: ScrollbarTarget;
}

/** Active scrollbar drag; geometry is snapshotted at press time. */
interface ScrollbarDrag {
	onChange: (offset: number) => void;
	trackTop: number;
	trackHeight: number;
	thumbHeight: number;
	maxScroll: number;
	/** Row within the thumb where the pointer grabbed it (centered for track clicks). */
	grabOffset: number;
}

/**
 * True when a prop takes part in layout. `children`/`key` are matched
 * separately by reconciliation, and callbacks are render-only (no layout
 * handler reads them), so a fresh closure must not force Yoga FFI churn.
 */
function isLayoutProp(key: string, value: unknown): boolean {
	return key !== "children" && key !== "key" && typeof value !== "function";
}

/**
 * Shallow prop compare for layout purposes. Gates redundant re-application of
 * Yoga layout setters — the dominant cost when large trees re-commit with
 * unchanged props.
 */
function layoutPropsEqual(a: object, b: object): boolean {
	if (a === b) return true;
	const aProps = a as Record<string, unknown>;
	const bProps = b as Record<string, unknown>;
	const aKeys = Object.keys(aProps).filter((k) => isLayoutProp(k, aProps[k]));
	const bKeys = Object.keys(bProps).filter((k) => isLayoutProp(k, bProps[k]));
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (aProps[k] !== bProps[k]) return false;
	}
	return true;
}

/**
 * Full shallow prop compare (children included, by reference). Gates
 * memoized component re-invocation — see `memo.ts` for the contract.
 */
function memoPropsEqual(a: object, b: object): boolean {
	if (a === b) return true;
	const aProps = a as Record<string, unknown>;
	const bProps = b as Record<string, unknown>;
	const aKeys = Object.keys(aProps);
	if (aKeys.length !== Object.keys(bProps).length) return false;
	for (const k of aKeys) {
		if (aProps[k] !== bProps[k]) return false;
	}
	return true;
}

export class Renderer {
	terminal: Terminal;
	rootInstance: Instance | null = null;
	disposeEffect: (() => void) | null = null;
	/** Scrollbar currently being dragged by the pointer, if any. */
	private scrollbarDrag: ScrollbarDrag | null = null;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	renderInstance(instance: Instance, parentX = 0, parentY = 0, inheritedBg: string | null = null): Position[] {
		const context: RenderContext = {
			parentX: Math.round(parentX),
			parentY: Math.round(parentY),
			inheritedBg,
			renderInstance: this.renderInstance.bind(this),
		};

		const { render } = getElement(instance.type);
		return render(instance, context);
	}

	/**
	 * Route a pointer report: presses toggle click targets or grab a scrollbar,
	 * motion while grabbed drags it, releases end the drag. Rectangles come from
	 * the same computed Yoga geometry the element handlers paint with;
	 * `scrollArea` descendants are shifted by the scroll offset and clipped to
	 * the viewport. Later-painted children win, and the deepest match beats its
	 * ancestors, so a click on row text bubbles to the row's `onClick`.
	 */
	hitTest(event: KeyEvent): boolean {
		const mouse = event.mouse;
		if (!mouse || !this.rootInstance) return false;

		if (mouse.action === "release") {
			const wasDragging = this.scrollbarDrag !== null;
			this.scrollbarDrag = null;
			return wasDragging;
		}

		if (mouse.action === "move") {
			if (!this.scrollbarDrag) return false;
			this.dragScrollbar(mouse.y);
			return true;
		}

		// Only primary-button presses are clicks: wheel reports also use
		// `action: "press"`, and scroll motion must never activate targets.
		if (mouse.button !== "left") return false;

		// A fresh press ends any stale drag (e.g. the release was lost).
		this.scrollbarDrag = null;
		const target = this.findPointerTarget(this.rootInstance, 0, 0, mouse.x, mouse.y, null);
		if (!target) return false;

		if (target.scrollbar) {
			this.startScrollbarDrag(target.scrollbar, mouse.y);
			return true;
		}

		target.instance.props.onClick?.(event);
		return true;
	}

	private startScrollbarDrag(bar: ScrollbarTarget, y: number) {
		const { metrics, onChange } = bar;
		const onThumb = y >= metrics.thumbTop && y < metrics.thumbTop + metrics.thumbHeight;
		this.scrollbarDrag = {
			onChange,
			trackTop: metrics.top,
			trackHeight: metrics.trackHeight,
			thumbHeight: metrics.thumbHeight,
			maxScroll: metrics.maxScroll,
			// Grab the thumb where it was pressed; a track click centers it.
			grabOffset: onThumb ? y - metrics.thumbTop : Math.floor(metrics.thumbHeight / 2),
		};
		this.dragScrollbar(y);
	}

	private dragScrollbar(y: number) {
		const drag = this.scrollbarDrag;
		if (!drag) return;
		const travel = drag.trackHeight - drag.thumbHeight;
		if (travel <= 0) return;
		const thumbTop = Math.max(0, Math.min(travel, y - drag.trackTop - drag.grabOffset));
		const offset = Math.round((thumbTop / travel) * drag.maxScroll);
		drag.onChange(Math.max(0, Math.min(drag.maxScroll, offset)));
	}

	private findPointerTarget(
		instance: Instance,
		parentX: number,
		parentY: number,
		x: number,
		y: number,
		clip: ClipRect | null,
	): PointerTarget | null {
		if (clip && (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom)) return null;

		const left = parentX + Math.round(instance.yogaNode.getComputedLeft());
		const top = parentY + Math.round(instance.yogaNode.getComputedTop());
		const width = Math.round(instance.yogaNode.getComputedWidth());
		const height = Math.round(instance.yogaNode.getComputedHeight());

		const isScrollArea = instance.type === ElementType.SCROLL_AREA;
		if (isScrollArea && instance.props.scrollbar) {
			const onChange = instance.props.onScrollOffsetChange;
			if (onChange) {
				const metrics = scrollbarMetrics({
					x: left,
					y: top,
					width,
					height,
					contentHeight: scrollContentHeight(instance),
					scrollOffset: instance.props.scrollOffset ?? 0,
				});
				if (metrics && x === metrics.x && y >= metrics.top && y < metrics.top + metrics.trackHeight) {
					return { instance, scrollbar: { metrics, onChange } };
				}
			}
		}

		const childY = isScrollArea ? top - Math.max(0, instance.props.scrollOffset ?? 0) : top;
		const childClip = isScrollArea ? { left, top, right: left + width - 1, bottom: top + height - 1 } : clip;

		for (let i = instance.children.length - 1; i >= 0; i--) {
			const child = instance.children[i];
			if (!child) continue;
			const found = this.findPointerTarget(child, left, childY, x, y, childClip);
			if (found) return found;
		}

		const inside = x >= left && x < left + width && y >= top && y < top + height;
		// Positioned overlays (DiffViewer, CommandPalette) cover earlier siblings,
		// so a click inside an overlay that missed its inner targets must stop here
		// instead of piercing through to the background tree.
		const isOverlay = instance.type === ElementType.BOX && instance.props.position === "absolute";
		return inside && (instance.props.onClick !== undefined || isOverlay) ? { instance } : null;
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
			const componentType = vnode.type;
			const memoProps = vnode.props as Record<string, unknown>;
			const store = hookStore ?? createHookStore();
			setCurrentStore(store);
			let firstOutput: VNode | undefined;
			while (typeof vnode.type === "function") {
				const resolved = (vnode.type as any)(vnode.props);
				if (firstOutput === undefined) firstOutput = resolved;
				vnode = resolved;
			}
			clearCurrentStore();
			const instance = this.mountInstance(vnode);
			instance.hookStore = store;
			this.recordMemoState(instance, componentType, memoProps, firstOutput);
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
			const memoProps = vnode.props as Record<string, unknown>;
			const store = createHookStore();
			setCurrentStore(store);
			let firstOutput: VNode | undefined;
			while (typeof vnode.type === "function") {
				const resolved = (vnode.type as any)(vnode.props);
				if (firstOutput === undefined) firstOutput = resolved;
				vnode = resolved;
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
			this.recordMemoState(childInstance, componentType, memoProps, firstOutput);
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

	/**
	 * Record memo state on the output instance for a memoized component. The
	 * reconciler reuses it to skip re-invocation while props stay shallow-equal.
	 * The stored output is the component's *direct* output VNode (which may be
	 * another component, e.g. `<Box>`), so a hit re-reconciles that output
	 * without re-running the memoized body. See `memo.ts` for the contract.
	 */
	private recordMemoState(
		instance: Instance,
		componentType: unknown,
		props: Record<string, unknown>,
		output: VNode | null | undefined,
	) {
		if (!isMemoized(componentType) || !output) return;
		instance.memoComponent = componentType;
		instance.memoProps = props;
		instance.memoOutput = output;
	}

	/** True when a memoized component's previous output can be reused verbatim. */
	private canReuseMemo(existing: Instance | null, componentType: unknown, props: object): existing is Instance {
		const reusable =
			!!existing &&
			existing.memoComponent === componentType &&
			existing.memoProps !== undefined &&
			existing.memoOutput !== undefined &&
			existing.memoOutput !== null &&
			memoPropsEqual(existing.memoProps, props);
		return reusable;
	}

	// --- Reconcile path: diff VNode against existing Instance tree ---

	reconcile(vnode: VNode, existing: Instance | null): Instance | null {
		if (typeof vnode.type === "function") {
			const componentType = vnode.type;
			// Memo fast path: pure component with unchanged props reuses its
			// previous output (see memo.ts).
			if (isMemoized(componentType) && this.canReuseMemo(existing, componentType, vnode.props)) {
				return this.reconcile(existing.memoOutput!, existing);
			}
			const memoProps = vnode.props as Record<string, unknown>;
			const store = existing?.hookStore ?? createHookStore();
			setCurrentStore(store);
			let firstOutput: VNode | undefined;
			while (typeof vnode.type === "function") {
				const resolved = (vnode.type as any)(vnode.props);
				if (!resolved) {
					clearCurrentStore();
					if (existing) this.freeYogaNodes(existing);
					return null;
				}
				if (firstOutput === undefined) firstOutput = resolved;
				vnode = resolved;
			}
			clearCurrentStore();
			const instance = this.reconcile(vnode, existing);
			if (!instance) return null;
			instance.hookStore = store;
			this.recordMemoState(instance, componentType, memoProps, firstOutput);
			return instance;
		}

		if (vnode.type === "fragment") {
			return this.reconcile({ type: ElementType.BOX, props: { children: vnode.props.children } }, existing);
		}

		const type = typeof vnode.type === "string" ? vnode.type : ElementType.BOX;

		if (!existing || existing.type !== type) {
			if (existing) this.freeYogaNodes(existing);
			return this.mountInstance(vnode);
		}

		const element = getElement(type);
		const previousProps = existing.props as Record<string, unknown>;
		const propsUnchanged = layoutPropsEqual(previousProps, vnode.props);
		// Layout handlers ignore `children` (reconciled separately), but elements
		// whose measure function reads content from their props (e.g. `<Text>`)
		// must still re-apply layout when only the children changed: the handler
		// re-installs its measure function and marks the node dirty.
		const childrenChanged =
			!element.hasChildren && previousProps.children !== (vnode.props as { children?: unknown }).children;
		existing.props = vnode.props;
		// Yoga setter calls are FFI and dominate large-tree commits; only the
		// element's own props (children reconcile separately) require them.
		if (!propsUnchanged || childrenChanged) {
			element.layout(existing);
		}

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

		// Skip the Yoga child-list rebuild when it is unchanged: removing and
		// re-inserting children dirties the node and forces a full re-layout
		// of the subtree (plus FFI churn) even when every child kept its
		// position. `parentInstance.children` is kept in sync with the Yoga
		// child list by mount and reconcile, so a JS compare is enough.
		const unchanged =
			oldChildren.length === newChildren.length && newChildren.every((child, i) => child === oldChildren[i]);
		if (!unchanged) {
			const childCount = parentInstance.yogaNode.getChildCount();
			for (let i = childCount - 1; i >= 0; i--) {
				parentInstance.yogaNode.removeChild(parentInstance.yogaNode.getChild(i));
			}
			for (let i = 0; i < newChildren.length; i++) {
				const child = newChildren[i];
				if (child) parentInstance.yogaNode.insertChild(child.yogaNode, i);
			}
		}

		parentInstance.children = newChildren;
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

	private resolveAndReconcile(children: unknown[], ctx: ReconcileCtx, newChildren: Instance[]) {
		for (const child of children) {
			if (typeof child === "string" || typeof child === "number") {
				const oldChild = this.consumeOldChild(ctx, undefined);
				const text = child.toString();

				if (oldChild && oldChild.type === ElementType.TEXT) {
					const oldProps = oldChild.props as Record<string, unknown>;
					const unchanged = oldProps.children === text && Object.keys(oldProps).length === 1;
					if (!unchanged) {
						oldChild.props = { children: text };
						const element = getElement(ElementType.TEXT);
						element.layout(oldChild);
						if (oldProps.children !== text && oldChild.props.height === undefined) {
							oldChild.yogaNode.markDirty();
						}
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
						// Memo fast path: pure component with unchanged props
						// reuses its previous output (see memo.ts).
						if (isMemoized(componentType) && this.canReuseMemo(oldChild, componentType, vnode.props)) {
							const inst = this.reconcile(oldChild.memoOutput!, oldChild);
							if (inst) {
								inst.componentType = componentType;
								newChildren.push(inst);
							}
							continue;
						}
						store = oldChild?.hookStore ?? createHookStore();
						const memoProps = vnode.props as Record<string, unknown>;
						let firstOutput: VNode | undefined;
						setCurrentStore(store);
						while (typeof vnode.type === "function") {
							const resolved = (vnode.type as any)(vnode.props);
							if (!resolved) {
								vnode = null as any;
								break;
							}
							if (firstOutput === undefined) firstOutput = resolved;
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
								this.recordMemoState(inst, componentType, memoProps, firstOutput);
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
		inputManager.setPointerHandler((event) => this.hitTest(event));
		this.disposeEffect = effect(() => {
			// Track terminal size so a resize triggers a fresh layout + repaint.
			// oxlint-disable-next-line no-unused-expressions -- signal read for tracking
			this.terminal.size.value;
			this.commitRender(createVNode());
		});
	}

	unmount() {
		inputManager.setPointerHandler(null);
		this.scrollbarDrag = null;
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
		unmount: () => renderer.unmount(),
	};
}

export function run(
	createVNode: (quit: () => void) => VNode,
	onBeforeQuit?: () => void | Promise<void>,
	options: TerminalOptions = {},
) {
	const terminal = new Terminal(process.stdout, options);

	const quit = async () => {
		if (onBeforeQuit) await onBeforeQuit();
		cleanupKey();
		inputManager.stop();
		unmount();
		// Flush teardown bytes (exit-alternate-screen) before killing the
		// process — process.exit() drops queued stdout writes otherwise.
		await terminal.drain().catch(() => {});
		process.exit(0);
	};

	const { unmount } = render(() => createVNode(quit), terminal);

	inputManager.start();

	const cleanupKey = inputManager.onKeyGlobal((event) => {
		if (event.ctrl && event.key === "c") {
			void quit();
		}
		return false;
	});

	return { unmount, terminal };
}
