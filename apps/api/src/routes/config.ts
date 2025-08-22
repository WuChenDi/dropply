import { Hono } from 'hono'
import type { CloudflareEnv } from '@/types'

export const configRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /config
configRoutes.get('/config', async (c) => {
  const config = {
    requireTOTP: c.env.REQUIRE_TOTP === 'true',
  }

  return c.json(config)
})
