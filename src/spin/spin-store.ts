import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { MalformedRecord, RecordNotFound, RevisionConflict, type StoreError } from "./errors.ts";
import { CurrentInvocation } from "./invocation.ts";
import {
  decodeEntry,
  DEFINITION_ENTRY,
  DefinitionEntryData,
  type SpinDefinition,
  type SpinRecord,
  type SpinRunState,
  STATE_ENTRY,
  StateEntryData,
} from "./model.ts";

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

  /**
   * Spins whose latest state has no final status: interrupted by reload, reopen or a crash.
   * Spins with malformed entries are skipped.
   */
  readonly listUnfinished: Effect.Effect<ReadonlyArray<SpinRecord>>;

  /**
   * Save the next run state if the stored revision is still `expectedRevision`. The
   * definition is never changed.
   */
  updateRunState(
    spinId: string,
    expectedRevision: number,
    next: SpinRunState,
  ): Effect.Effect<SpinRecord, StoreError>;
}>()("pi-spin/spin/SpinStore") {
  /** Writes through `pi.appendEntry` and reads the calling handler's session (CurrentInvocation). */
  static readonly layer = (pi: ExtensionAPI) => Layer.succeed(SpinStore, makeSpinStore(pi));
}

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

const isSpinEntry = (entry: SessionEntry): entry is CustomEntry =>
  entry.type === "custom" && (entry.customType === DEFINITION_ENTRY || entry.customType === STATE_ENTRY);

/** Read the id without decoding, so other Spins' entries are not validated on every load. */
const spinIdOf = (entry: CustomEntry) =>
  Predicate.isObject(entry.data) && Predicate.isString(entry.data["spinId"]) ? entry.data["spinId"] : undefined;

const sessionEntries = Effect.gen(function*() {
  const invocation = yield* CurrentInvocation;
  if (!invocation) return yield* new MalformedRecord({ entryId: "", message: "No Pi context to read the session from." });
  return invocation.context.sessionManager;
});

/** Rebuild one Spin from its entries: the definition and the highest revision. */
const rebuild = Effect.fnUntraced(function*(spinId: string, entries: ReadonlyArray<CustomEntry>) {
  let record: SpinRecord | undefined;
  for (const entry of entries) {
    const data = yield* decodeEntry(entry);
    if ("definition" in data) {
      if (record) return yield* new MalformedRecord({ entryId: entry.id, message: "A second definition for this Spin." });
      record = { spinId, revision: 0, definition: data.definition, state: data.state, entryId: entry.id };
    } else {
      if (!record) return yield* new MalformedRecord({ entryId: entry.id, message: "A state entry before its definition." });
      if (data.revision !== record.revision + 1) {
        return yield* new MalformedRecord({ entryId: entry.id, message: `Expected revision ${record.revision + 1}, found ${data.revision}.` });
      }
      record = { ...record, revision: data.revision, state: data.state, entryId: entry.id };
    }
  }
  if (!record) return yield* new RecordNotFound({ spinId });
  return record;
});

function makeSpinStore(pi: ExtensionAPI): SpinStore["Service"] {
  /** Entries are in file order, which is write order. */
  const entriesOf = Effect.fnUntraced(function*(spinId?: string) {
    const manager = yield* sessionEntries;
    return manager.getEntries().filter(isSpinEntry).filter((entry) => spinId === undefined || spinIdOf(entry) === spinId);
  });

  const load = Effect.fn("SpinStore.load")(function*(spinId: string) {
    return yield* rebuild(spinId, yield* entriesOf(spinId));
  });

  // Validate before writing, so a bad value is never saved, then confirm the write landed.
  const append = Effect.fnUntraced(function*<A>(
    customType: string,
    data: A,
    validate: (data: A) => Effect.Effect<unknown, Schema.SchemaError>,
  ) {
    yield* validate(data).pipe(
      Effect.mapError((error) => new MalformedRecord({ entryId: "", message: `Refusing to save: ${error.message}` })),
    );
    const manager = yield* sessionEntries;
    pi.appendEntry(customType, data);
    const entryId = manager.getLeafId();
    const entry = entryId ? manager.getEntry(entryId) : undefined;
    if (!entry || entry.type !== "custom" || entry.customType !== customType) {
      return yield* new MalformedRecord({ entryId: entryId ?? "", message: "The saved entry was not found at the leaf." });
    }
    return entry.id;
  });

  return SpinStore.of({
    create: Effect.fn("SpinStore.create")(function*(definition, initial) {
      const spinId = randomUUID();
      const entryId = yield* append(
        DEFINITION_ENTRY,
        { version: 1 as const, spinId, revision: 0 as const, definition, state: initial },
        Schema.decodeEffect(DefinitionEntryData),
      );
      return { spinId, revision: 0, definition, state: initial, entryId };
    }),

    load,

    listUnfinished: Effect.gen(function*() {
      const entries = yield* entriesOf();
      const bySpin = new Map<string, CustomEntry[]>();
      for (const entry of entries) {
        const spinId = spinIdOf(entry);
        if (spinId !== undefined) bySpin.set(spinId, [...(bySpin.get(spinId) ?? []), entry]);
      }
      const unfinished: SpinRecord[] = [];
      for (const [spinId, spinEntries] of bySpin) {
        const record = yield* rebuild(spinId, spinEntries).pipe(Effect.orElseSucceed(() => undefined));
        if (record?.state.status._tag === "running") unfinished.push(record);
      }
      return unfinished;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<SpinRecord> => [])),

    updateRunState: Effect.fn("SpinStore.updateRunState")(function*(spinId, expectedRevision, next) {
      const current = yield* load(spinId);
      if (current.revision !== expectedRevision) {
        return yield* new RevisionConflict({ spinId, expected: expectedRevision, actual: current.revision });
      }
      const revision = current.revision + 1;
      const entryId = yield* append(
        STATE_ENTRY,
        { version: 1 as const, spinId, revision, state: next },
        Schema.decodeEffect(StateEntryData),
      );
      return { ...current, revision, state: next, entryId };
    }),
  });
}
