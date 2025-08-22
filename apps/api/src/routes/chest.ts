import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { eq, and } from 'drizzle-orm'
import { sessions, files } from '@/database/schema'
import type {
  CloudflareEnv,
  CreateChestRequest,
  CreateChestResponse,
  UploadFileResponse,
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateMultipartUploadRequest,
  CreateMultipartUploadResponse,
  CompleteMultipartUploadRequest,
  CompleteMultipartUploadResponse,
  UploadPartResponse,
} from '@/types'
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
  isValidUUID,
  calculateExpiry,
  getFileExtension,
} from '@/lib'

export const chestRoutes = new Hono<{ Bindings: CloudflareEnv }>()

// GET /config - 获取服务器配置
chestRoutes.get('/config', async (c) => {
  const config = {
    requireTOTP: c.env.REQUIRE_TOTP === 'true',
  }

  return c.json(config)
})

// POST /chest - 创建新的 chest
chestRoutes.post('/chest', async (c) => {
  const db = useDrizzle(c)
  const requireTOTP = c.env.REQUIRE_TOTP === 'true'

  if (requireTOTP) {
    let requestBody: CreateChestRequest
    try {
      requestBody = await c.req.json()
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' })
    }

    if (!requestBody.totpToken) {
      throw new HTTPException(401, { message: 'TOTP token required' })
    }

    if (!c.env.TOTP_SECRETS) {
      throw new HTTPException(500, { message: 'TOTP not configured on server' })
    }

    const isValidTOTP = await verifyAnyTOTP(
      requestBody.totpToken,
      c.env.TOTP_SECRETS,
    )
    if (!isValidTOTP) {
      throw new HTTPException(401, { message: 'Invalid TOTP token' })
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

    return c.json(response)
  } catch (error) {
    logger.error('Failed to create chest session', { sessionId, error })
    throw new HTTPException(500, { message: 'Failed to create session' })
  }
})

// POST /chest/:sessionId/upload - 上传文件
chestRoutes.post('/chest/:sessionId/upload', async (c) => {
  const db = useDrizzle(c)
  const sessionId = c.req.param('sessionId')

  // 验证JWT令牌
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }

  const token = authHeader.substring(7)
  let payload
  try {
    payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid token' })
  }

  if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
    throw new HTTPException(400, { message: 'Invalid session' })
  }

  // 检查会话是否存在且未完成
  const session = await db
    ?.select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.uploadComplete, 0),
        withNotDeleted(sessions),
      ),
    )
    .get()

  if (!session) {
    throw new HTTPException(404, {
      message: 'Session not found or already completed',
    })
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

      r2Operations.push(c.env.R2_STORAGE.put(`${sessionId}/${fileId}`, content))

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

    const response: UploadFileResponse = { uploadedFiles }
    return c.json(response)
  } catch (error) {
    logger.error('Failed to upload files', { sessionId, error })
    throw new HTTPException(500, { message: 'Failed to upload files' })
  }
})

// POST /chest/:sessionId/complete - 完成上传并生成检索码
chestRoutes.post('/chest/:sessionId/complete', async (c) => {
  const db = useDrizzle(c)
  const sessionId = c.req.param('sessionId')

  // 验证JWT令牌
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }

  const token = authHeader.substring(7)
  let payload
  try {
    payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid token' })
  }

  if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
    throw new HTTPException(400, { message: 'Invalid session' })
  }

  const body: CompleteUploadRequest = await c.req.json()
  const { fileIds, validityDays } = body

  // 验证文件ID
  for (const fileId of fileIds) {
    if (!isValidUUID(fileId)) {
      throw new HTTPException(400, { message: 'Invalid file ID format' })
    }
  }

  // 验证文件所有权
  const fileCount = await db
    ?.select()
    .from(files)
    .where(and(eq(files.sessionId, sessionId), withNotDeleted(files)))

  if (fileCount?.length !== fileIds.length) {
    throw new HTTPException(400, {
      message: 'Some files do not belong to this session',
    })
  }

  const retrievalCode = generateRetrievalCode()
  const expiryDate = calculateExpiry(validityDays)

  try {
    // 更新会话
    const result = await db
      ?.update(sessions)
      .set({
        retrievalCode,
        uploadComplete: 1,
        expiresAt: expiryDate,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.uploadComplete, 0),
          withNotDeleted(sessions),
        ),
      )

    logger.info('Chest upload completed', {
      sessionId,
      retrievalCode,
      expiryDate,
    })

    const response: CompleteUploadResponse = {
      retrievalCode,
      expiryDate: expiryDate?.toISOString() || null,
    }

    return c.json(response)
  } catch (error) {
    logger.error('Failed to complete upload', { sessionId, error })
    throw new HTTPException(500, { message: 'Failed to complete upload' })
  }
})

// POST /chest/:sessionId/multipart/create - 创建分片上传
chestRoutes.post('/chest/:sessionId/multipart/create', async (c) => {
  const db = useDrizzle(c)
  const sessionId = c.req.param('sessionId')

  // 验证JWT令牌
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }

  const token = authHeader.substring(7)
  let payload
  try {
    payload = await verifyUploadJWT(token, c.env.JWT_SECRET)
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid token' })
  }

  if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
    throw new HTTPException(400, { message: 'Invalid session' })
  }

  // 检查会话存在且未完成
  const session = await db
    ?.select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.uploadComplete, 0),
        withNotDeleted(sessions),
      ),
    )
    .get()

  if (!session) {
    throw new HTTPException(404, {
      message: 'Session not found or already completed',
    })
  }

  const body: CreateMultipartUploadRequest = await c.req.json()
  const { filename, mimeType, fileSize } = body

  if (!filename || !mimeType || !fileSize || fileSize <= 0) {
    throw new HTTPException(400, {
      message: 'Invalid multipart upload parameters',
    })
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

    const response: CreateMultipartUploadResponse = {
      fileId,
      uploadId: multipartToken, // 返回JWT而不是原始uploadId
    }

    return c.json(response)
  } catch (error) {
    logger.error('Failed to create multipart upload', {
      sessionId,
      fileId,
      error,
    })
    throw new HTTPException(500, {
      message: 'Failed to create multipart upload',
    })
  }
})

// PUT /chest/:sessionId/multipart/:fileId/part/:partNumber - 上传分片
chestRoutes.put(
  '/chest/:sessionId/multipart/:fileId/part/:partNumber',
  async (c) => {
    const sessionId = c.req.param('sessionId')
    const fileId = c.req.param('fileId')
    const partNumber = Number.parseInt(c.req.param('partNumber'))

    // 验证分片JWT令牌
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Unauthorized' })
    }

    const token = authHeader.substring(7)
    let payload
    try {
      payload = await verifyMultipartJWT(token, c.env.JWT_SECRET)
    } catch (error) {
      throw new HTTPException(401, { message: 'Invalid multipart token' })
    }

    if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
      throw new HTTPException(403, {
        message: 'Token does not match upload session',
      })
    }

    if (!isValidUUID(sessionId) || !isValidUUID(fileId)) {
      throw new HTTPException(400, {
        message: 'Invalid session or file ID format',
      })
    }

    if (partNumber < 1 || partNumber > 10000) {
      throw new HTTPException(400, { message: 'Invalid part number' })
    }

    // 获取请求体
    const body = await c.req.arrayBuffer()
    if (!body || body.byteLength === 0) {
      throw new HTTPException(400, { message: 'Empty part body' })
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

      const response: UploadPartResponse = {
        etag: uploadedPart.etag,
        partNumber,
      }

      return c.json(response)
    } catch (error) {
      logger.error('Failed to upload part', {
        sessionId,
        fileId,
        partNumber,
        error,
      })
      throw new HTTPException(500, { message: 'Failed to upload part' })
    }
  },
)

// POST /chest/:sessionId/multipart/:fileId/complete - 完成分片上传
chestRoutes.post('/chest/:sessionId/multipart/:fileId/complete', async (c) => {
  const db = useDrizzle(c)
  const sessionId = c.req.param('sessionId')
  const fileId = c.req.param('fileId')

  // 验证分片JWT令牌
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }

  const token = authHeader.substring(7)
  let payload
  try {
    payload = await verifyMultipartJWT(token, c.env.JWT_SECRET)
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid multipart token' })
  }

  if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
    throw new HTTPException(403, {
      message: 'Token does not match upload session',
    })
  }

  if (!isValidUUID(sessionId) || !isValidUUID(fileId)) {
    throw new HTTPException(400, {
      message: 'Invalid session or file ID format',
    })
  }

  const body: CompleteMultipartUploadRequest = await c.req.json()
  const { parts } = body

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new HTTPException(400, { message: 'Invalid parts array' })
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

    const response: CompleteMultipartUploadResponse = {
      fileId,
      filename: payload.filename,
    }

    return c.json(response)
  } catch (error) {
    logger.error('Failed to complete multipart upload', {
      sessionId,
      fileId,
      error,
    })
    throw new HTTPException(500, {
      message: 'Failed to complete multipart upload',
    })
  }
})
