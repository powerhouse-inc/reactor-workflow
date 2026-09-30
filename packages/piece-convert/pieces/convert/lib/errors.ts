export type ConvertErrorKind =
  /** The request was wrong before it was sent, or the service said 400. */
  | "VALIDATION"
  /** 415: the format is not one this service can read. */
  | "UNSUPPORTED"
  /** 503: the service converts one document at a time and is busy. */
  | "BUSY"
  /** 500: the conversion itself failed; the service's message is passed on. */
  | "CONVERT_FAILED"
  /** Nothing answered at the URL. */
  | "UNREACHABLE"
  /** The conversion outlived the step's deadline. */
  | "DEADLINE";

/**
 * A typed failure, so a workflow can tell "try again in a moment" from "this
 * file will never convert". `retryable` is the one the engine acts on.
 */
export class ConvertError extends Error {
  readonly kind: ConvertErrorKind;
  readonly retryable: boolean;

  constructor(kind: ConvertErrorKind, message: string, retryable = false) {
    super(message);
    this.name = "ConvertError";
    this.kind = kind;
    this.retryable = retryable;
  }
}
