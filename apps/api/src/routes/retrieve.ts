import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { eq, and } from 'drizzle-orm'
import { sessions, files } from '@/database/schema'
import type { CloudflareEnv, RetrieveChestResponse } from '@/types'
import {
  useDrizzle,
  withNotDeleted,
  createChestJWT,
  retrievalCodeParamSchema,
} from '@/lib'

export const retrieveRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /retrieve/:retrievalCode - 获取 chest 内容
retrieveRoutes.get(
  '/retrieve/:retrievalCode',
  zValidator('param', retrievalCodeParamSchema),
  async (c) => {
    const db = useDrizzle(c)
    const { retrievalCode } = c.req.valid('param')

    // 查找会话
    const session = await db
      ?.select()
      .from(sessions)
      .where(
        withNotDeleted(
          sessions,
          and(
            eq(sessions.retrievalCode, retrievalCode),
            eq(sessions.uploadComplete, 1),
          ),
        ),
      )
      .get()

    if (!session) {
      throw new HTTPException(404, {
        message: 'Retrieval code not found or expired',
      })
    }

    // 检查是否过期
    if (session.expiresAt && session.expiresAt < new Date()) {
      throw new HTTPException(404, { message: 'Retrieval code expired' })
    }

    // 获取所有文件
    const sessionFiles = await db
      ?.select()
      .from(files)
      .where(withNotDeleted(files, eq(files.sessionId, session.id)))
      .orderBy(files.createdAt)

    if (!sessionFiles || sessionFiles.length === 0) {
      throw new HTTPException(404, {
        message: 'No files found for this session',
      })
    }

    // 创建 chest JWT
    const chestToken = await createChestJWT(
      session.id,
      session.expiresAt,
      c.env.JWT_SECRET,
    )

    logger.info('Chest retrieved', {
      retrievalCode,
      sessionId: session.id,
      fileCount: sessionFiles.length,
    })

    const response: RetrieveChestResponse = {
      files: sessionFiles.map((file) => ({
        fileId: file.id,
        filename: file.originalFilename,
        size: file.fileSize,
        mimeType: file.mimeType,
        isText: Boolean(file.isText),
        fileExtension: file.fileExtension,
      })),
      chestToken,
      expiryDate: session.expiresAt?.toISOString() || null,
    }

    return c.json(response)
  },
)
