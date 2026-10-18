import * as Sentry from '@sentry/browser'

declare global {
  interface Window {
    __HALO_SENTRY_DSN__?: string
  }
}

let started = false

// Tracing plus session replay. Replay masks text, inputs, and media so
// prescriptions, names, and voice samples are not recorded.
export function initSentry(surface: 'care' | 'patient') {
  const dsn = window.__HALO_SENTRY_DSN__ || import.meta.env.VITE_SENTRY_DSN
  if (started || !dsn) return
  started = true

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: 'halo-care-portal',
    tracesSampleRate: 1,
    tracePropagationTargets: [/^\//, /^http:\/\/localhost/],
    replaysSessionSampleRate: 1,
    replaysOnErrorSampleRate: 1,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        networkDetailAllowUrls: [],
        networkCaptureBodies: false,
      }),
    ],
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'ui.input' || breadcrumb.category === 'console') return null
      const url = breadcrumb.data?.url
      if (typeof url === 'string') breadcrumb.data!.url = stripQuery(url)
      return breadcrumb
    },
    beforeSend(event) {
      if (event.request?.url) event.request.url = stripQuery(event.request.url)
      return event
    },
  })

  Sentry.setTag('surface', surface)
}

function stripQuery(url: string) {
  try {
    const parsed = new URL(url, 'http://localhost')
    return parsed.pathname
  } catch {
    return url.split('?')[0]
  }
}
