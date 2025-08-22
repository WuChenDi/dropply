import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { eq, and } from 'drizzle-orm'
import { sessions, files } from '@/database/schema'
import type { CloudflareEnv, RetrieveChestResponse } from '@/types'
import {
  useDrizzle,
  withNotDeleted,
  createChestJWT,
  verifyChestJWT,
  isValidRetrievalCode,
  isValidUUID,
} from '@/lib'

export const retrieveRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /retrieve/:retrievalCode - 获取 chest 内容
retrieveRoutes.get('/retrieve/:retrievalCode', async (c) => {
  const db = useDrizzle(c)
  const retrievalCode = c.req.param('retrievalCode')

  if (!isValidRetrievalCode(retrievalCode)) {
    throw new HTTPException(400, { message: 'Invalid retrieval code format' })
  }

  // 查找会话
  const session = await db
    ?.select()
    .from(sessions)
    .where(
      and(
        eq(sessions.retrievalCode, retrievalCode),
        eq(sessions.uploadComplete, 1),
        withNotDeleted(sessions),
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
    .where(and(eq(files.sessionId, session.id), withNotDeleted(files)))
    .orderBy(files.createdAt)

  if (!sessionFiles || sessionFiles.length === 0) {
    throw new HTTPException(404, { message: 'No files found for this session' })
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
})

// GET /download/:fileId - 下载文件
retrieveRoutes.get('/download/:fileId', async (c) => {
  const db = useDrizzle(c)
  const fileId = c.req.param('fileId')

  // 提取令牌
  const authHeader = c.req.header('Authorization')
  const tokenFromQuery = c.req.query('token')
  const filenameFromQuery = c.req.query('filename')

  let token: string
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7)
  } else if (tokenFromQuery) {
    token = tokenFromQuery
  } else {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }

  let payload
  try {
    payload = await verifyChestJWT(token, c.env.JWT_SECRET)
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid token' })
  }

  if (!isValidUUID(fileId)) {
    throw new HTTPException(400, { message: 'Invalid file ID format' })
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
    throw new HTTPException(404, {
      message: 'File not found or session expired',
    })
  }

  // 检查会话是否过期
  if (result.sessions.expiresAt && result.sessions.expiresAt < new Date()) {
    throw new HTTPException(404, { message: 'File session expired' })
  }

  // 从R2获取文件
  const r2Object = await c.env.R2_STORAGE.get(`${payload.sessionId}/${fileId}`)
  if (!r2Object) {
    throw new HTTPException(404, { message: 'File not found in storage' })
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
})
