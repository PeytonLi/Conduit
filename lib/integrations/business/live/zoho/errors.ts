export class ZohoApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly zohoCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ZohoApiError";
  }

  get notFound(): boolean {
    return this.httpStatus === 404;
  }
}

/** Zoho answered 429: per-minute, daily or concurrency limit. */
export class ZohoRateLimitError extends ZohoApiError {
  constructor(message: string) {
    super(429, null, message);
    this.name = "ZohoRateLimitError";
  }
}

/** The request may or may not have reached Zoho (network failure or timeout). */
export class ZohoTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoTransportError";
  }
}

export class ZohoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoAuthError";
  }
}

export class ZohoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoDataError";
  }
}
