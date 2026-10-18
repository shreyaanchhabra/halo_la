import * as Sentry from '@sentry/node'
import { careOperation } from '../src/operations'

type Headers = Record<string, string | string[] | undefined>

let enabled = false

export function initCareSentry(dsn: string, environment: string) {
  if (enabled || !dsn) return
  Sentry.init({
    dsn,
    environment,
    release: 'halo-care-portal',
    tracesSampleRate: 1,
    tracePropagationTargets: ['localhost'],
  })
  enabled = true
}

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export function traceCareRequest<T>(
  req: { method?: string; headers: Headers },
  pathname: string,
  fn: () => Promise<T>,
): Promise<T> {
  // The glasses check in every few seconds; tracing each one would bury the real care actions
  if (!enabled || (req.method === 'GET' && (pathname === '/api/glasses' || pathname === '/api/glasses/state'))) return fn()
  return Sentry.continueTrace(
    { sentryTrace: header(req.headers['sentry-trace']), baggage: header(req.headers.baggage) },
    () => Sentry.startSpan(
      {
        name: careOperation(req.method ?? 'GET', pathname),
        op: 'http.server',
        attributes: { 'http.request.method': req.method ?? 'GET' },
      },
      () => fn(),
    ),
  )
}

export function reportError(err: unknown) {
  if (!enabled) return
  const span = Sentry.getActiveSpan()
  if (span) Sentry.setHttpStatus(span, 500)
  Sentry.captureException(err)
}

export function finishRequest(status: number) {
  if (!enabled || status >= 500) return
  const span = Sentry.getActiveSpan()
  if (span && status) Sentry.setHttpStatus(span, status)
}

// Work that runs outside a page request (price lookups, iMessage) gets its own trace.
export async function traceTask(name: string, op: string, fn: () => Promise<unknown>): Promise<void> {
  if (!enabled) {
    await fn().catch(() => {})
    return
  }
  await Sentry.startNewTrace(() => Sentry.startSpan({ name, op, forceTransaction: true }, async () => {
    try {
      await fn()
    } catch (err) {
      Sentry.captureException(err)
    }
  }))
}

// One step inside the current request, with what it decided (e.g. who spoke, and how sure)
export function traceStep<T>(name: string, op: string, fn: () => T, attributes?: (result: T) => Record<string, string | number>): T {
  if (!enabled) return fn()
  return Sentry.startSpan({ name, op }, span => {
    const result = fn()
    if (attributes) span.setAttributes(attributes(result))
    return result
  })
}

export function tracePriceLookup(fn: () => Promise<unknown>): void {
  void traceTask('Look up GoodRx prices', 'pharmacy.lookup', fn)
}
