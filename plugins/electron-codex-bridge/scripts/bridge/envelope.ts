import type http from "node:http";

export class BridgeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string = bridgeErrorCodeForStatus(status)) {
    super(message);
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, BridgeRequestError.prototype);
  }
}

export function bridgeErrorCodeForStatus(status: number): string {
  switch (status) {
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 404:
      return "NOT_FOUND";
    case 403:
      return "FORBIDDEN";
    default:
      return "INVALID_REQUEST";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sendData(res: http.ServerResponse, status: number, data: unknown): void {
  sendJson(res, status, { ok: true, data });
}

export function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, {
    ok: false,
    error: { code, message }
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}
