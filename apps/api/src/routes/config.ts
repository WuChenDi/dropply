import { Hono } from 'hono'
import type { CloudflareEnv } from '@/types'

export const configRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /config
configRoutes.get('/config', async (c) => {
  const config = {
    requireTOTP: c.env.REQUIRE_TOTP === 'true',
    emailShareEnabled: !!(
      c.env.RESEND_API_KEY && c.env.ENABLE_EMAIL_SHARE === 'true'
    ),
  }

  return c.json(config)
})
