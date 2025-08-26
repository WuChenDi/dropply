import { Hono } from 'hono'
import type { CloudflareEnv } from '@/types'
import type { ApiResponse, ConfigResponse } from '@cdlab996/dropply-utils'

export const configRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /config
configRoutes.get('/config', async (c) => {
  return c.json<ApiResponse<ConfigResponse>>({
    code: 0,
    message: 'ok',
    data: {
      requireTOTP: c.env.REQUIRE_TOTP === 'true',
      emailShareEnabled: !!(
        c.env.RESEND_API_KEY && c.env.ENABLE_EMAIL_SHARE === 'true'
      ),
    },
  })
})
