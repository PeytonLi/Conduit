export class DomainValidationError extends Error {
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, field?: string, message = code) {
    super(message);
    this.name = "DomainValidationError";
    this.code = code;
    this.field = field;
  }
}
