import { Context, type Effect } from "effect";
import type { MalformedRecord, RecordNotFound, StoreError } from "./errors.ts";
import type { SpinDefinition, SpinRecord, SpinRunState } from "./model.ts";

/**
 * Saves Spins as non-context session entries (`spin-definition`, `spin-state`) and reads them
 * across every branch with `getEntries()`. Each write appends at the current leaf and moves
 * the leaf onto the new entry, so writes return that entry's id. It never decides what
 * happens next.
 */
export class SpinStore extends Context.Service<SpinStore, {
  /** Generate an id and save the approved definition with its initial run state (revision 0). */
  create(definition: SpinDefinition, initial: SpinRunState): Effect.Effect<SpinRecord, StoreError>;

  /** The highest revision saved for `spinId`. */
  load(spinId: string): Effect.Effect<SpinRecord, RecordNotFound | MalformedRecord>;

  /** Spins whose latest state has no final status: interrupted by reload, reopen or a crash. */
  readonly listUnfinished: Effect.Effect<ReadonlyArray<SpinRecord>, MalformedRecord>;

  /**
   * Save the next run state if the stored revision is still `expectedRevision`. The
   * definition is never changed.
   */
  updateRunState(
    spinId: string,
    expectedRevision: number,
    next: SpinRunState,
  ): Effect.Effect<SpinRecord, StoreError>;
}>()("pi-spin/spin/SpinStore") {}
