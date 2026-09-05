import { Rpc } from "@opencode-ai/plugin/rpc";

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

export const Productivity = Rpc.define({
  id: "ocProductivity",
  methods: {
    status: { output: healthSchema },
    refresh: { output: healthSchema },
    get: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: getSchema,
    },
  },
});
