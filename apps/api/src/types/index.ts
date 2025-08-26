export interface CloudflareEnv {
  R2_STORAGE: R2Bucket

  JWT_SECRET: string
  TOTP_SECRETS?: string
  REQUIRE_TOTP?: string

  // Email Configuration
  ENABLE_EMAIL_SHARE?: string
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
  RESEND_WEB_URL?: string
}

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
