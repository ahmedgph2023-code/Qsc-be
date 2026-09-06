export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errStatus(e: unknown): number {
  return e instanceof HttpError ? e.status : 500;
}
