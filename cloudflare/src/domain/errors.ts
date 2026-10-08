/** A request that breaks a business rule (not enough stock, above MRP, ...). HTTP 400, message shown to the user. */
export class BillingError extends Error {}

/** HTTP error with a status and a message for the user. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public fieldErrors?: Record<string, string>) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, `${what} not found: ${id}`);
