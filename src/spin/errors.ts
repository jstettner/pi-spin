import { Schema } from "effect";

// Failures the services report to Spin. Spin turns each into a stop reason; none of them
// is a completion verdict.

/** The session, leaf or idle state no longer matches what Spin expected. */
export class SessionChanged extends Schema.TaggedError<SessionChanged>()("SessionChanged", {
  message: Schema.String,
}) {}

/** A session action could not run: navigation cancelled or landed elsewhere, or no command context. */
export class HostActionFailed extends Schema.TaggedError<HostActionFailed>()("HostActionFailed", {
  action: Schema.String,
  message: Schema.String,
}) {}

export class RecordNotFound extends Schema.TaggedError<RecordNotFound>()("RecordNotFound", {
  spinId: Schema.String,
}) {}

/** The stored revision moved on: a late event tried to overwrite newer state. */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()("RevisionConflict", {
  spinId: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int,
}) {}

/** A spin entry in the session file failed validation. */
export class MalformedRecord extends Schema.TaggedError<MalformedRecord>()("MalformedRecord", {
  entryId: Schema.String,
  message: Schema.String,
}) {}

export type StoreError = RecordNotFound | RevisionConflict | MalformedRecord;

/** The check did not produce a valid verdict: script error, timeout, classifier failure or bad envelope. */
export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  kind: Schema.Literals(["script", "timeout", "classifier", "verdict", "capability"]),
  message: Schema.String,
  diagnostics: Schema.optionalKey(Schema.String),
}) {}

/** A Spin operation was called in a phase that does not allow it. */
export class SpinRejected extends Schema.TaggedError<SpinRejected>()("SpinRejected", {
  message: Schema.String,
}) {}

/** The proposal or a stored definition failed validation. */
export class InvalidProposal extends Schema.TaggedError<InvalidProposal>()("InvalidProposal", {
  message: Schema.String,
}) {}
