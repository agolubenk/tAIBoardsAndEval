// A refusal the person can fix, named by a stable code so the connect form
// can put the message under the field that needs the change.
export class SourceAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceAccessError";
  }
}
