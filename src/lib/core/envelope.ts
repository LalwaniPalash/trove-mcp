import type { Envelope, EnvelopeMeta, ProvenanceRecord, Status } from "../types/common.js";

let defaultEnvelopeMeta: EnvelopeMeta = {
  version: "0.1.0",
};

export function setDefaultEnvelopeMeta(meta: EnvelopeMeta): void {
  defaultEnvelopeMeta = meta;
}

export function getDefaultEnvelopeMeta(): EnvelopeMeta {
  return defaultEnvelopeMeta;
}

export function makeEnvelope<T>(args: {
  data: T;
  status?: Status;
  degraded?: boolean;
  warnings?: string[];
  provenance?: ProvenanceRecord[];
  meta?: EnvelopeMeta;
}): Envelope<T> {
  return {
    status: args.status ?? "ok",
    degraded: args.degraded ?? false,
    warnings: args.warnings ?? [],
    provenance: args.provenance ?? [],
    meta: args.meta ?? defaultEnvelopeMeta,
    data: args.data,
  };
}

export function envelopeToText<T>(envelope: Envelope<T>): string {
  return JSON.stringify(envelope, null, 2);
}
