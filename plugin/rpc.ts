// The RPC contract other plugins/clients import (package `./rpc` export).
// Dependency-free: defineRpc is the vendored SDK identity (see define.ts).
import { defineRpc } from "./define.ts";

const healthSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    host: { type: "string" },
    port: { type: "number" },
    url: { type: "string" },
    generated: { type: "string" },
    sessions: { type: "number" },
    age_s: { type: "number" },
    extracting: { type: "boolean" },
    error: { type: "string" },
    cache: { type: "string" },
  },
  required: [
    "ok",
    "host",
    "port",
    "url",
    "generated",
    "sessions",
    "age_s",
    "extracting",
    "error",
    "cache",
  ],
  additionalProperties: false,
} as const;

const getSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    generated: { type: "string" },
    sessions: { type: "number" },
    extracting: { type: "boolean" },
  },
  required: ["url", "generated", "sessions", "extracting"],
  additionalProperties: false,
} as const;

const contributeSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    dryRun: { type: "boolean" },
    install: { type: "string" },
    rows: { type: "number" },
    changed: { type: "number" },
    sent: { type: "number" },
    dayMin: { type: "string" },
    dayMax: { type: "string" },
    models: { type: "number" },
    status: { type: "number" },
    snapshot: { type: "string" },
    error: { type: "string" },
  },
  required: [
    "ok",
    "dryRun",
    "install",
    "rows",
    "changed",
    "sent",
    "dayMin",
    "dayMax",
    "models",
  ],
  additionalProperties: false,
} as const;

const contributeStatusSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    source: { type: "string" },
    lastSent: { type: "string" },
    rowsTotal: { type: "number" },
    nextDue: { type: "string" },
    parked: { type: "boolean" },
  },
  required: ["enabled", "source", "lastSent", "rowsTotal", "nextDue", "parked"],
  additionalProperties: false,
} as const;

const contributedEventSchema = {
  type: "object",
  properties: {
    rows: { type: "number" },
    total: { type: "number" },
    snapshot: { type: "string" },
    auto: { type: "boolean" },
  },
  required: ["rows", "total", "snapshot", "auto"],
  additionalProperties: false,
} as const;

const settingsEventSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
  },
  required: ["enabled"],
  additionalProperties: false,
} as const;

export const Insights = defineRpc({
  id: "ocInsights",
  events: {
    contributed: { schema: contributedEventSchema },
    settings: { schema: settingsEventSchema },
  },
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: healthSchema,
    },
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: healthSchema,
    },
    get: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: getSchema,
    },
    contribute: {
      input: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
          refresh: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: contributeSchema,
    },
    contributeStatus: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: contributeStatusSchema,
    },
    setContribute: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: contributeStatusSchema,
    },
  },
});

export type ContribEventName = "contributed" | "settings";
