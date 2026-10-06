/** Headless presentation contracts; no Pi, files, agent or React imports.
 * Services are closed over by the host. An interface does not install code or
 * confer authority, and a feature preserves its concrete controller type.
 */
export interface ValueSchema<Value> {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly parse: (value: unknown) => Value;
}

export interface ViewerDescriptor {
  readonly kind: string;
  readonly version: number;
  readonly title?: string;
}

export interface ViewerController<State, Actions, Tools = unknown> {
  /** Pure cached snapshot. Without a change, return the same value/object.
   * Do not mutate an already published snapshot or perform I/O while reading.
   */
  readonly getSnapshot: () => State;
  /** Synchronous subscription and unsubscription. Change notification occurs
   * after snapshot publication. This callback is not an async execution queue.
   */
  readonly subscribe: (listener: () => void) => () => void;
  readonly actions: Actions;
  readonly tools: Tools;
  /** Explicit owner teardown can be asynchronous. Await/handle its result.
   * Releasing this controller must not dispose a borrowed provider or task.
   * React unsubscription stays synchronous; owner teardown is a separate step.
   */
  readonly dispose: () => void | Promise<void>;
}

/** Preserve the whole concrete controller, including flush, custom methods,
 * server-rendering snapshots and other host extensions. Do not reconstruct a
 * base controller from State/Actions/Tools and silently erase its capabilities.
 */
export interface ViewerFeature<
  Descriptor extends ViewerDescriptor,
  Controller extends ViewerController<unknown, unknown, unknown>,
> {
  readonly kind: Descriptor['kind'];
  readonly version: Descriptor['version'];
  readonly descriptor: ValueSchema<Descriptor>;
  readonly createController: (descriptor: Descriptor) => Controller;
}

export type ViewerRenderer<Controller, Rendered> = (controller: Controller) => Rendered;

export interface ViewerTarget<Subject = unknown> {
  readonly instanceId: string;
  readonly epoch: string;
  readonly subject: Subject;
}

export type PresentationResult<Output, Subject = unknown> =
  | { readonly kind: 'applied'; readonly value: Output }
  | { readonly kind: 'proposed'; readonly proposalId: string; readonly base: ViewerTarget<Subject> }
  | { readonly kind: 'stale' | 'conflict' | 'denied' | 'unavailable'; readonly reason: string };

/** Function properties retain strict input/target variance. Native tool
 * adapters bind this metadata through Pi; this is not another tool engine.
 */
export interface PresentationCommand<Input, Output, Subject = unknown> {
  readonly name: string;
  readonly input: ValueSchema<Input>;
  readonly invoke: (target: ViewerTarget<Subject>, input: Input, signal?: AbortSignal) => Promise<PresentationResult<Output, Subject>>;
}
