import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { eq, and } from 'drizzle-orm'
import { sessions, files } from '@/database/schema'
import {
  createUploadJWT,
  createMultipartJWT,
  verifyUploadJWT,
  verifyMultipartJWT,
  useDrizzle,
  withNotDeleted,
  verifyAnyTOTP,
  generateUUID,
  generateRetrievalCode,
  calculateExpiry,
  getFileExtension,
  createChestRequestSchema,
  completeUploadRequestSchema,
  createMultipartUploadRequestSchema,
  completeMultipartUploadRequestSchema,
  sessionIdParamSchema,
  fileIdParamSchema,
  partNumberParamSchema,
} from '@/lib'

import type {
  ApiResponse,
  CreateChestResponse,
  UploadFileResponse,
  CompleteUploadResponse,
  CreateMultipartUploadResponse,
  CompleteMultipartUploadResponse,
  UploadPartResponse,
} from '@cdlab996/dropply-utils'
import type { CloudflareEnv } from '@/types'

export const chestRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// POST /chest - 创建新的 chest
chestRoutes.post(
  '/chest',
  zValidator('json', createChestRequestSchema),
  async (c) => {
    const requestId = c.get('requestId')

    const db = useDrizzle(c)
    const requireTOTP = c.env.REQUIRE_TOTP === 'true'
    const { totpToken } = c.req.valid('json')

    // TOTP 验证
    if (requireTOTP) {
      if (!totpToken) {
        return c.json<ApiResponse>(
          {
            code: 401,
            message: 'TOTP token required',
          },
          401,
        )
      }

      if (!c.env.TOTP_SECRETS) {
        return c.json<ApiResponse>(
          {
            code: 500,
            message: 'TOTP not configured on server',
          },
          500,
        )
      }

      const isValidTOTP = await verifyAnyTOTP(totpToken, c.env.TOTP_SECRETS)
      if (!isValidTOTP) {
        return c.json<ApiResponse>(
          {
            code: 401,
            message: 'Invalid TOTP token',
          },
          401,
        )
      }
    }

    const sessionId = generateUUID()
    const uploadToken = await createUploadJWT(sessionId, c.env.JWT_SECRET)

    try {
      await db?.insert(sessions).values({
        id: sessionId,
        uploadComplete: 0,
      })

      logger.info('Created new chest session', { sessionId })

      const response: CreateChestResponse = {
        sessionId,
        uploadToken,
        expiresIn: 86400, // 24小时
      }

      return c.json<ApiResponse<CreateChestResponse>>({
        code: 0,
        message: 'ok',
        data: {
          ...response,
        },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to create chest session, ${JSON.stringify({
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })}`,
      )

      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create session'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)

// POST /chest/:sessionId/upload - 上传文件
chestRoutes.post(
  '/chest/:sessionId/upload',
  zValidator('param', sessionIdParamSchema),
  async (c) => {
    const requestId = c.get('requestId')
    const db = useDrizzle(c)
    const { sessionId } = c.req.valid('param')

    // 验证JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid token',
        },
        401,
      )
    }

    if (payload.sessionId !== sessionId) {
      return c.json<ApiResponse>(
        {
          code: 400,
          message: 'Invalid session',
        },
        400,
      )
    }

    // 检查会话是否存在且未完成
    const session = await db
      ?.select()
      .from(sessions)
      .where(
        withNotDeleted(
          sessions,
          and(eq(sessions.id, sessionId), eq(sessions.uploadComplete, 0)),
        ),
      )
      .get()

    if (!session) {
      return c.json<ApiResponse>(
        {
          code: 404,
          message: 'Session not found or already completed',
        },
        404,
      )
    }

    // 解析表单数据
    const formData = await c.req.formData()
    const uploadedFiles: Array<{
      fileId: string
      filename: string
      isText: boolean
    }> = []
    const r2Operations: Promise<any>[] = []
    const fileInserts: any[] = []

    // 处理文件上传
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        const fileId = generateUUID()
        const filename = value.name || 'unnamed-file'
        const mimeType = value.type || 'application/octet-stream'
        const fileSize = value.size

        // 队列化R2操作
        r2Operations.push(
          c.env.R2_STORAGE.put(`${sessionId}/${fileId}`, value.stream()),
        )

        // 队列化数据库操作
        fileInserts.push({
          id: fileId,
          sessionId,
          originalFilename: filename,
          mimeType,
          fileSize,
          fileExtension: getFileExtension(filename),
          isText: 0,
        })

        uploadedFiles.push({ fileId, filename, isText: false })
      }
    }

    // 处理文本项
    const textItems = formData.getAll('textItems')
    for (const textItem of textItems) {
      if (typeof textItem === 'string') {
        const textData = JSON.parse(textItem)
        const fileId = generateUUID()
        const filename = textData.filename || `text-${Date.now()}.txt`
        const content = textData.content
        const mimeType = 'text/plain'
        const fileSize = new TextEncoder().encode(content).length

        r2Operations.push(
          c.env.R2_STORAGE.put(`${sessionId}/${fileId}`, content),
        )

        fileInserts.push({
          id: fileId,
          sessionId,
          originalFilename: filename,
          mimeType,
          fileSize,
          fileExtension: getFileExtension(filename),
          isText: 1,
        })

        uploadedFiles.push({ fileId, filename, isText: true })
      }
    }

    try {
      // 并行执行所有操作
      await Promise.all([
        Promise.all(r2Operations),
        fileInserts.length > 0
          ? db?.insert(files).values(fileInserts)
          : Promise.resolve(),
      ])

      logger.info('Files uploaded successfully', {
        sessionId,
        count: uploadedFiles.length,
      })

      return c.json<ApiResponse<UploadFileResponse>>({
        code: 0,
        message: 'ok',
        data: { uploadedFiles },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to upload files, ${JSON.stringify({
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })}`,
      )

      const errorMessage =
        error instanceof Error ? error.message : 'Failed to upload files'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)

// POST /chest/:sessionId/complete - 完成上传并生成检索码
chestRoutes.post(
  '/chest/:sessionId/complete',
  zValidator('param', sessionIdParamSchema),
  zValidator('json', completeUploadRequestSchema),
  async (c) => {
    const requestId = c.get('requestId')
    const db = useDrizzle(c)
    const { sessionId } = c.req.valid('param')
    const { fileIds, validityDays } = c.req.valid('json')

    // 验证JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid token',
        },
        401,
      )
    }

    if (payload.sessionId !== sessionId) {
      return c.json<ApiResponse>(
        {
          code: 400,
          message: 'Invalid session',
        },
        400,
      )
    }

    // 验证文件所有权
    const fileCount = await db
      ?.select()
      .from(files)
      .where(withNotDeleted(files, eq(files.sessionId, sessionId)))

    if (fileCount?.length !== fileIds.length) {
      return c.json<ApiResponse>(
        {
          code: 400,
          message: 'Some files do not belong to this session',
        },
        400,
      )
    }

    const retrievalCode = generateRetrievalCode()
    const expiryDate = calculateExpiry(validityDays)

    try {
      // 更新会话
      await db
        ?.update(sessions)
        .set({
          retrievalCode,
          uploadComplete: 1,
          expiresAt: expiryDate,
          updatedAt: new Date(),
        })
        .where(
          withNotDeleted(
            sessions,
            and(eq(sessions.id, sessionId), eq(sessions.uploadComplete, 0)),
          ),
        )

      logger.info('Chest upload completed', {
        sessionId,
        retrievalCode,
        expiryDate,
      })

      return c.json<ApiResponse<CompleteUploadResponse>>({
        code: 0,
        message: 'ok',
        data: {
          retrievalCode,
          expiryDate: expiryDate?.toISOString() || null,
        },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to complete upload, ${JSON.stringify({
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })}`,
      )

      const errorMessage =
        error instanceof Error ? error.message : 'Failed to complete upload'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)

// POST /chest/:sessionId/multipart/create - 创建分片上传
chestRoutes.post(
  '/chest/:sessionId/multipart/create',
  zValidator('param', sessionIdParamSchema),
  zValidator('json', createMultipartUploadRequestSchema),
  async (c) => {
    const requestId = c.get('requestId')
    const db = useDrizzle(c)
    const { sessionId } = c.req.valid('param')
    const { filename, mimeType, fileSize } = c.req.valid('json')

    // 验证JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid token',
        },
        401,
      )
    }

    if (payload.sessionId !== sessionId) {
      return c.json<ApiResponse>(
        {
          code: 400,
          message: 'Invalid session',
        },
        400,
      )
    }

    // 检查会话存在且未完成
    const session = await db
      ?.select()
      .from(sessions)
      .where(
        withNotDeleted(
          sessions,
          and(eq(sessions.id, sessionId), eq(sessions.uploadComplete, 0)),
        ),
      )
      .get()

    if (!session) {
      return c.json<ApiResponse>(
        {
          code: 404,
          message: 'Session not found or already completed',
        },
        404,
      )
    }

    const fileId = generateUUID()

    try {
      // 在R2创建分片上传
      const multipartUpload = await c.env.R2_STORAGE.createMultipartUpload(
        `${sessionId}/${fileId}`,
      )

      // 创建分片JWT（48小时有效期）
      const multipartToken = await createMultipartJWT(
        sessionId,
        fileId,
        multipartUpload.uploadId,
        filename,
        mimeType,
        fileSize,
        c.env.JWT_SECRET,
      )

      logger.info('Multipart upload created', { sessionId, fileId, filename })

      return c.json<ApiResponse<CreateMultipartUploadResponse>>({
        code: 0,
        message: 'ok',
        data: {
          fileId,
          uploadId: multipartToken,
        },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to create multipart upload, ${JSON.stringify({
          sessionId,
          fileId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })}`,
      )

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to create multipart upload'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)

// PUT /chest/:sessionId/multipart/:fileId/part/:partNumber - 上传分片
chestRoutes.put(
  '/chest/:sessionId/multipart/:fileId/part/:partNumber',
  zValidator(
    'param',
    sessionIdParamSchema.merge(fileIdParamSchema).merge(partNumberParamSchema),
  ),
  async (c) => {
    const requestId = c.get('requestId')
    const { sessionId, fileId, partNumber } = c.req.valid('param')

    // 验证分片JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyMultipartJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid multipart token',
        },
        401,
      )
    }

    if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
      return c.json<ApiResponse>(
        {
          code: 403,
          message: 'Token does not match upload session',
        },
        403,
      )
    }

    // 获取请求体
    const body = await c.req.arrayBuffer()
    if (!body || body.byteLength === 0) {
      return c.json<ApiResponse>(
        {
          code: 400,
          message: 'Empty part body',
        },
        400,
      )
    }

    try {
      // 恢复分片上传并上传分片
      const multipartUpload = c.env.R2_STORAGE.resumeMultipartUpload(
        `${sessionId}/${fileId}`,
        payload.uploadId,
      )
      const uploadedPart = await multipartUpload.uploadPart(partNumber, body)

      logger.info('Part uploaded successfully', {
        sessionId,
        fileId,
        partNumber,
      })

      return c.json<ApiResponse<UploadPartResponse>>({
        code: 0,
        message: 'ok',
        data: {
          etag: uploadedPart.etag,
          partNumber,
        },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to upload part, ${JSON.stringify({
          sessionId,
          fileId,
          partNumber,
          error,
        })}`,
      )

      const errorMessage =
        error instanceof Error ? error.message : 'Failed to upload part'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)

// POST /chest/:sessionId/multipart/:fileId/complete - 完成分片上传
chestRoutes.post(
  '/chest/:sessionId/multipart/:fileId/complete',
  zValidator('param', sessionIdParamSchema.merge(fileIdParamSchema)),
  zValidator('json', completeMultipartUploadRequestSchema),
  async (c) => {
    const requestId = c.get('requestId')
    const db = useDrizzle(c)
    const { sessionId, fileId } = c.req.valid('param')
    const { parts } = c.req.valid('json')

    // 验证分片JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Unauthorized',
        },
        401,
      )
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyMultipartJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      return c.json<ApiResponse>(
        {
          code: 401,
          message: 'Invalid multipart token',
        },
        401,
      )
    }

    if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
      return c.json<ApiResponse>(
        {
          code: 403,
          message: 'Token does not match upload session',
        },
        403,
      )
    }

    // 按分片号排序
    const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber)

    try {
      // 恢复分片上传并完成
      const multipartUpload = c.env.R2_STORAGE.resumeMultipartUpload(
        `${sessionId}/${fileId}`,
        payload.uploadId,
      )
      await multipartUpload.complete(sortedParts)

      // 成功完成后插入文件记录到数据库
      await db?.insert(files).values({
        id: fileId,
        sessionId,
        originalFilename: payload.filename,
        mimeType: payload.mimeType,
        fileSize: payload.fileSize,
        fileExtension: getFileExtension(payload.filename),
        isText: 0,
      })

      logger.info('Multipart upload completed', {
        sessionId,
        fileId,
        filename: payload.filename,
      })

      return c.json<ApiResponse<CompleteMultipartUploadResponse>>({
        code: 0,
        message: 'ok',
        data: {
          fileId,
          filename: payload.filename,
        },
      })
    } catch (error) {
      logger.error(
        `[${requestId}] Failed to complete multipart upload, ${JSON.stringify({
          sessionId,
          fileId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })}`,
      )

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to complete multipart upload'
      return c.json<ApiResponse>(
        {
          code: 500,
          message: errorMessage,
        },
        500,
      )
    }
  },
)
