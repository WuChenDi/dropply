import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { eq, and } from 'drizzle-orm'
import { sessions, files } from '@/database/schema'
import {
  useDrizzle,
  withNotDeleted,
  verifyChestJWT,
  fileIdParamSchema,
  downloadQuerySchema,
} from '@/lib'

import type { ApiResponse } from '@cdlab996/dropply-utils'
import type { CloudflareEnv } from '@/types'

export const downloadRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /download/:fileId - 下载文件
downloadRoutes.get(
  '/download/:fileId',
  zValidator('param', fileIdParamSchema),
  zValidator('query', downloadQuerySchema),
  async (c) => {
    const db = useDrizzle(c)
    const { fileId } = c.req.valid('param')
    const { token: tokenFromQuery, filename: filenameFromQuery } =
      c.req.valid('query')

    // 提取令牌
    const authHeader = c.req.header('Authorization')

    let token: string
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7)
    } else if (tokenFromQuery) {
      token = tokenFromQuery
    } else {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    let payload
    try {
      payload = await verifyChestJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid token',
        },
        401,
      )
    }

    // 获取文件元数据并验证会话仍然有效
    const fileWithSession = await db
      ?.select()
      .from(files)
      .innerJoin(sessions, eq(files.sessionId, sessions.id))
      .where(
        and(
          eq(files.id, fileId),
          eq(files.sessionId, payload.sessionId),
          withNotDeleted(files),
          withNotDeleted(sessions),
        ),
      )

    // 检查查询结果
    const result = fileWithSession?.[0]
    if (!result) {
      return c.json<ApiResponse>(
        {
          code: 404,
          message: 'File not found or session expired',
        },
        404,
      )
    }

    // 检查会话是否过期
    if (result.sessions.expiresAt && result.sessions.expiresAt < new Date()) {
      return c.json<ApiResponse>(
        {
          code: 404,
          message: 'File session expired',
        },
        404,
      )
    }

    // 从R2获取文件
    const r2Object = await c.env.R2_STORAGE.get(
      `${payload.sessionId}/${fileId}`,
    )
    if (!r2Object) {
      return c.json<ApiResponse>(
        {
          code: 404,
          message: 'File not found in storage',
        },
        404,
      )
    }

    // 使用查询参数中的文件名，否则使用原始文件名
    const downloadFilename = filenameFromQuery || result.files.originalFilename

    logger.info('File downloaded', {
      fileId,
      sessionId: payload.sessionId,
      filename: downloadFilename,
    })

    // 返回文件
    return new Response(r2Object.body, {
      headers: {
        'Content-Type': result.files.mimeType,
        'Content-Disposition': `attachment; filename="${downloadFilename}"`,
        'Content-Length': String(result.files.fileSize),
      },
    })
  },
)
