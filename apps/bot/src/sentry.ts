import * as Sentry from '@sentry/node';
import '@sentry/tracing';
import { RewriteFrames } from '@sentry/integrations';
import config from 'config';

const sentryOpts: any = config.get('sentry');

Sentry.init({
  dsn: sentryOpts.dsn,
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new RewriteFrames({
      root: __dirname
    })
  ],

  environment: sentryOpts.env || process.env.NODE_ENV || 'development',
  release: `craig-bot@${require('../package.json').version}`,
  tracesSampleRate: sentryOpts.sampleRate ? parseFloat(sentryOpts.sampleRate) : 1.0
});

export function close() {
  return Sentry.close();
}
