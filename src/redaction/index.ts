/**
 * One vocabulary for content that must not leave.
 *
 * Owned by neither the tracer nor the exporter, because both need it and
 * neither should depend on the other: a rule written once covers span
 * attributes and exports alike.
 */
export * as Redaction from "./Redaction.js"
