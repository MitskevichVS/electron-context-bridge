import type http from "node:http";

import { BridgeRequestError } from "./envelope.ts";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function resolveMaxBodyBytes(optionValue: number | undefined): number {
  const envValue = process.env.CODEX_ELECTRON_BRIDGE_MAX_BODY_BYTES;
  const value = optionValue ?? (envValue ? Number(envValue) : DEFAULT_MAX_BODY_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Codex bridge maxBodyBytes must be a positive safe integer.");
  }
  return value;
}

export async function readJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  const contentLength = Array.isArray(req.headers["content-length"])
    ? req.headers["content-length"][0]
    : req.headers["content-length"];

  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new BridgeRequestError(400, "Invalid content-length header.");
    }
    if (declaredLength > maxBodyBytes) {
      throw new BridgeRequestError(413, `Request body exceeds ${maxBodyBytes} bytes.`);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new BridgeRequestError(413, `Request body exceeds ${maxBodyBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeRequestError(400, "Request body must be valid JSON.");
  }

  if (!isJsonObject(parsed)) {
    throw new BridgeRequestError(400, "Request body must be a JSON object.");
  }

  return parsed;
}

export function requireNonEmptyString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BridgeRequestError(400, `${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new BridgeRequestError(400, `${fieldName} must be at most ${maxLength} characters.`);
  }
  return value;
}

export function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BridgeRequestError(400, `${fieldName} must be an array.`);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeRequestError(400, `${fieldName} must be a positive integer.`);
  }
  return value;
}

export function requireOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new BridgeRequestError(400, `${fieldName} must be a boolean.`);
  }
  return value;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
