export interface CloudflareEnv {
  R2_STORAGE: R2Bucket

  JWT_SECRET: string
  TOTP_SECRETS?: string
  REQUIRE_TOTP?: string
}

// API 请求/响应类型
export interface CreateChestRequest {
  totpToken?: string
}

export interface CreateChestResponse {
  sessionId: string
  uploadToken: string
  expiresIn: number
}

export interface UploadFileResponse {
  uploadedFiles: Array<{
    fileId: string
    filename: string
    isText: boolean
  }>
}

// 分片上传类型
export interface CreateMultipartUploadRequest {
  filename: string
  mimeType: string
  fileSize: number
}

export interface CreateMultipartUploadResponse {
  fileId: string
  uploadId: string
}

export interface UploadPartResponse {
  etag: string
  partNumber: number
}

export interface CompleteMultipartUploadRequest {
  parts: Array<{
    partNumber: number
    etag: string
  }>
}

export interface CompleteMultipartUploadResponse {
  fileId: string
  filename: string
}

export interface CompleteUploadRequest {
  fileIds: string[]
  validityDays: number // 1, 3, 7, 15, 或 -1 表示永久
}

export interface CompleteUploadResponse {
  retrievalCode: string
  expiryDate: string | null
}

export interface RetrieveChestResponse {
  files: Array<{
    fileId: string
    filename: string
    size: number
    mimeType: string
    isText: boolean
    fileExtension: string | null
  }>
  chestToken: string
  expiryDate: string | null
}

// JWT 载荷类型
export interface UploadJWTPayload {
  sessionId: string
  type: 'upload'
  iat: number
  exp: number
}

export interface ChestJWTPayload {
  sessionId: string
  type: 'chest'
  iat: number
  exp: number
}

export interface MultipartJWTPayload {
  sessionId: string
  fileId: string
  uploadId: string
  filename: string
  mimeType: string
  fileSize: number
  type: 'multipart'
  iat: number
  exp: number
}
