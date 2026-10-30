// A refusal the person can fix, named by a stable code so the connect form
// can put the message under the field that needs the change. `target` names
// the one entry refused (a database ID), so a form with several can point at it.
export class SourceAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly target?: string,
  ) {
    super(message);
    this.name = "SourceAccessError";
  }
}
