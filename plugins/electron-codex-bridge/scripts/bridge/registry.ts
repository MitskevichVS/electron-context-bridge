import { BridgeRequestError } from "./envelope.ts";
import { isJsonObject, isJsonPrimitive } from "./validation.ts";

export type BridgeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type CodexBridgeHandlerParameterType =
  | "any"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export type CodexBridgeHandlerParameterMetadata = {
  name: string;
  type?: CodexBridgeHandlerParameterType;
  required?: boolean;
  description?: string;
  enum?: Array<string | number | boolean | null>;
};

export type CodexBridgeHandlerMetadata = {
  description?: string;
  args?: string[];
  parameters?: CodexBridgeHandlerParameterMetadata[];
  returns?: string;
};

export type BridgeHandlerRecord = {
  handler: BridgeHandler;
  metadata: CodexBridgeHandlerMetadata;
};

export const MAX_HANDLER_NAME_LENGTH = 120;

const handlers = new Map<string, BridgeHandlerRecord>();
const MAX_HANDLER_DESCRIPTION_LENGTH = 500;
const MAX_HANDLER_ARG_DESCRIPTION_LENGTH = 160;
const MAX_HANDLER_PARAMETER_COUNT = 20;
const MAX_HANDLER_PARAMETER_NAME_LENGTH = 80;
const MAX_HANDLER_PARAMETER_ENUM_VALUES = 100;
const MAX_HANDLER_RETURNS_LENGTH = 160;
const HANDLER_PARAMETER_TYPES = new Set([
  "any",
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null"
]);

export function registerCodexBridgeHandler(
  name: string,
  handler: BridgeHandler,
  metadata: CodexBridgeHandlerMetadata = {}
): void {
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_HANDLER_NAME_LENGTH) {
    throw new Error(`Codex bridge handler name must be 1-${MAX_HANDLER_NAME_LENGTH} characters.`);
  }
  if (typeof handler !== "function") {
    throw new Error("Codex bridge handler must be a function.");
  }
  handlers.set(name, {
    handler,
    metadata: normalizeHandlerMetadata(metadata)
  });
}

export function getCodexBridgeHandler(name: string): BridgeHandlerRecord | undefined {
  return handlers.get(name);
}

export function describeHandlers() {
  return [...handlers.entries()]
    .map(([name, record]) => ({
      name,
      ...record.metadata
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function validateHandlerArgs(
  parameters: CodexBridgeHandlerParameterMetadata[] | undefined,
  args: unknown[]
): void {
  if (parameters === undefined) return;
  if (args.length > parameters.length) {
    throw new BridgeRequestError(400, `args must contain at most ${parameters.length} value(s) for this handler.`);
  }

  parameters.forEach((parameter, index) => {
    if (index >= args.length) {
      if (parameter.required !== false) {
        throw new BridgeRequestError(400, `args[${index}] (${parameter.name}) is required.`);
      }
      return;
    }

    validateHandlerArg(parameter, args[index], index);
  });
}

function validateHandlerArg(
  parameter: CodexBridgeHandlerParameterMetadata,
  value: unknown,
  index: number
): void {
  const label = `args[${index}] (${parameter.name})`;
  const type = parameter.type || "any";

  if (!matchesParameterType(type, value)) {
    throw new BridgeRequestError(400, `${label} must be ${expectedTypeLabel(type)}.`);
  }

  if (parameter.enum && !parameter.enum.some((item) => Object.is(item, value))) {
    throw new BridgeRequestError(400, `${label} must be one of: ${parameter.enum.map(formatJsonLiteral).join(", ")}.`);
  }
}

function matchesParameterType(type: CodexBridgeHandlerParameterType, value: unknown): boolean {
  switch (type) {
    case "any":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
  }
}

function expectedTypeLabel(type: CodexBridgeHandlerParameterType): string {
  switch (type) {
    case "number":
      return "a finite number";
    case "integer":
      return "a safe integer";
    case "object":
      return "a JSON object";
    case "array":
      return "an array";
    case "null":
      return "null";
    case "any":
      return "any JSON value";
    default:
      return `a ${type}`;
  }
}

function normalizeHandlerMetadata(metadata: CodexBridgeHandlerMetadata): CodexBridgeHandlerMetadata {
  if (!isJsonObject(metadata)) {
    throw new Error("Codex bridge handler metadata must be an object.");
  }

  return {
    description: normalizeOptionalMetadataString(
      metadata.description,
      "description",
      MAX_HANDLER_DESCRIPTION_LENGTH
    ),
    args: normalizeHandlerArgDescriptions(metadata.args),
    parameters: normalizeHandlerParameters(metadata.parameters),
    returns: normalizeOptionalMetadataString(
      metadata.returns,
      "returns",
      MAX_HANDLER_RETURNS_LENGTH
    )
  };
}

function normalizeOptionalMetadataString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be at most ${maxLength} characters.`);
  }
  return value;
}

function normalizeHandlerArgDescriptions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Codex bridge handler metadata args must be an array.");
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`Codex bridge handler metadata args[${index}] must be a non-empty string.`);
    }
    if (item.length > MAX_HANDLER_ARG_DESCRIPTION_LENGTH) {
      throw new Error(`Codex bridge handler metadata args[${index}] must be at most ${MAX_HANDLER_ARG_DESCRIPTION_LENGTH} characters.`);
    }
    return item;
  });
}

function normalizeHandlerParameters(value: unknown): CodexBridgeHandlerParameterMetadata[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Codex bridge handler metadata parameters must be an array.");
  }
  if (value.length > MAX_HANDLER_PARAMETER_COUNT) {
    throw new Error(`Codex bridge handler metadata parameters must contain at most ${MAX_HANDLER_PARAMETER_COUNT} entries.`);
  }

  return value.map(normalizeHandlerParameter);
}

function normalizeHandlerParameter(value: unknown, index: number): CodexBridgeHandlerParameterMetadata {
  if (!isJsonObject(value)) {
    throw new Error(`Codex bridge handler metadata parameters[${index}] must be an object.`);
  }

  const name = normalizeRequiredMetadataString(
    value.name,
    `parameters[${index}].name`,
    MAX_HANDLER_PARAMETER_NAME_LENGTH
  );
  const type = normalizeHandlerParameterType(value.type, index);
  const required = normalizeOptionalMetadataBoolean(
    value.required,
    `parameters[${index}].required`,
    true
  );
  const description = normalizeOptionalMetadataString(
    value.description,
    `parameters[${index}].description`,
    MAX_HANDLER_ARG_DESCRIPTION_LENGTH
  );
  const enumValues = normalizeHandlerEnumValues(value.enum, `parameters[${index}].enum`);

  return {
    name,
    type,
    required,
    description,
    enum: enumValues
  };
}

function normalizeHandlerParameterType(
  value: unknown,
  index: number
): CodexBridgeHandlerParameterType {
  if (value === undefined) return "any";
  if (typeof value !== "string" || !HANDLER_PARAMETER_TYPES.has(value)) {
    throw new Error(`Codex bridge handler metadata parameters[${index}].type must be one of: ${[...HANDLER_PARAMETER_TYPES].join(", ")}.`);
  }
  return value as CodexBridgeHandlerParameterType;
}

function normalizeRequiredMetadataString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string {
  const normalized = normalizeOptionalMetadataString(value, fieldName, maxLength);
  if (normalized === undefined) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeOptionalMetadataBoolean(
  value: unknown,
  fieldName: string,
  defaultValue: boolean
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a boolean.`);
  }
  return value;
}

function normalizeHandlerEnumValues(
  value: unknown,
  fieldName: string
): Array<string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be an array.`);
  }
  if (value.length > MAX_HANDLER_PARAMETER_ENUM_VALUES) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must contain at most ${MAX_HANDLER_PARAMETER_ENUM_VALUES} values.`);
  }

  return value.map((item, index) => {
    if (!isJsonPrimitive(item)) {
      throw new Error(`Codex bridge handler metadata ${fieldName}[${index}] must be a string, number, boolean, or null.`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error(`Codex bridge handler metadata ${fieldName}[${index}] must be a finite number.`);
    }
    return item;
  });
}

function formatJsonLiteral(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}
