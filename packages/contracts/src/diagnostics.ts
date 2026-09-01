import { z } from 'zod';

import { TimestampSchema } from './shared';

/**
 * Why a client request failed, as the client itself saw it.
 *
 * These mirror the mobile request layer's own taxonomy. The distinction that
 * matters when diagnosing is between a request the server refused and one it
 * never received: a refusal is already in the server's own logs, while
 * everything else is invisible there.
 */
export const ClientFailureKindSchema = z.enum([
  'configuration',
  'invalid-response',
  'network',
  'status',
]);

/** Client-observed failure kind inferred from its schema. */
export type ClientFailureKind = z.infer<typeof ClientFailureKindSchema>;

/**
 * The route a failing request was aimed at, as a shape rather than a URL.
 *
 * Identifiers are substituted out before the report is built, so a diagnostic
 * says `/events/:id/api` and never carries an event, media, or session
 * identifier. This is what makes the report safe to log verbatim.
 */
export const ClientRouteShapeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^\/[A-Za-z0-9/:._-]*$/u,
    'A route shape is a path built from static segments and :id placeholders.',
  );

/**
 * One client-observed failure, reported so it can be diagnosed server-side.
 *
 * PSD EOC spent an emergency drill showing "the timeline is temporarily
 * unavailable" while the server recorded nothing at all, because the failing
 * request never reached it. Nothing the server logs can explain a request it
 * never received; only the client can say what it saw.
 *
 * The shape is deliberately narrow. It carries no message, no body, no token,
 * no journal content, and no free text of any kind, because a diagnostic that
 * can quote input cannot be logged verbatim -- and one that cannot be logged
 * verbatim does not get read during an incident.
 */
export const ClientDiagnosticReportSchema = z
  .object({
    kind: ClientFailureKindSchema,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    routeShape: ClientRouteShapeSchema,
    /** The HTTP status observed, or null when no response arrived at all. */
    status: z.number().int().min(100).max(599).nullable(),
    /** The server's request id, when a response carried one. */
    requestId: z.string().trim().max(64).nullable(),
    /** Which surface reported it, so mobile and web are separable. */
    surface: z.enum(['mobile', 'web']),
    applicationVersion: z
      .string()
      .trim()
      .regex(/^[0-9]+[.][0-9]+[.][0-9]+$/u)
      .nullable(),
    nativeBuildVersion: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,17}$/u)
      .nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    occurredAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** One client-observed failure inferred from its schema. */
export type ClientDiagnosticReport = z.infer<
  typeof ClientDiagnosticReportSchema
>;

/** The most reports one request may carry, so a loop cannot flood the log. */
export const MAX_CLIENT_DIAGNOSTIC_REPORTS = 20;

/** A bounded batch of client-observed failures. */
export const ClientDiagnosticBatchSchema = z
  .object({
    reports: z
      .array(ClientDiagnosticReportSchema)
      .min(1)
      .max(MAX_CLIENT_DIAGNOSTIC_REPORTS)
      .readonly(),
  })
  .strict()
  .readonly();

/** A bounded batch of client-observed failures inferred from its schema. */
export type ClientDiagnosticBatch = z.infer<typeof ClientDiagnosticBatchSchema>;
