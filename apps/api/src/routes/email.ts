import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { Resend } from 'resend'
import { sessions, files } from '@/database/schema'
import type { CloudflareEnv } from '@/types'
import { emailShareSchema, useDrizzle, withNotDeleted } from '@/lib'

export const emailRoutes = new Hono<{ Bindings: CloudflareEnv }>()

emailRoutes.post(
  '/email/share',
  zValidator('json', emailShareSchema),
  async (c) => {
    if (!c.env.RESEND_API_KEY || c.env.ENABLE_EMAIL_SHARE !== 'true') {
      throw new HTTPException(400, {
        message: 'Email sharing is not enabled on this server',
      })
    }

    if (!c.env.RESEND_FROM_EMAIL) {
      throw new HTTPException(500, {
        message: 'Email service not properly configured',
      })
    }

    const db = useDrizzle(c)
    const {
      retrievalCode,
      recipientEmail,
      recipientName,
      senderName,
      message,
    } = c.req.valid('json')

    try {
      const session = await db
        ?.select()
        .from(sessions)
        .where(
          withNotDeleted(sessions, eq(sessions.retrievalCode, retrievalCode)),
        )
        .get()

      if (!session) {
        throw new HTTPException(404, {
          message: 'Retrieval code not found',
        })
      }

      if (!session.uploadComplete) {
        throw new HTTPException(400, {
          message: 'Files are not ready for sharing yet',
        })
      }

      if (session.expiresAt && session.expiresAt < new Date()) {
        throw new HTTPException(404, {
          message: 'Retrieval code has expired',
        })
      }

      const sessionFiles = await db
        ?.select()
        .from(files)
        .where(withNotDeleted(files, eq(files.sessionId, session.id)))

      if (!sessionFiles || sessionFiles.length === 0) {
        throw new HTTPException(404, {
          message: 'No files found for this retrieval code',
        })
      }

      const resend = new Resend(c.env.RESEND_API_KEY)

      const emailHtml = generateEmailTemplate(
        retrievalCode,
        senderName,
        recipientName,
        message,
        session.expiresAt,
        sessionFiles,
      )

      const emailData = await resend.emails.send({
        from: c.env.RESEND_FROM_EMAIL || 'noreply@resend.dev',
        to: [recipientEmail],
        subject: `${senderName ? `${senderName} shared` : 'Someone shared'} files with you via Dropply`,
        html: emailHtml,
      })

      if (emailData.error) {
        logger.error('Resend API error', {
          error: emailData.error,
          retrievalCode,
        })
        throw new HTTPException(500, {
          message: 'Failed to send email. Please try again later.',
        })
      }

      logger.info('Email sent successfully', {
        retrievalCode,
        recipientEmail,
        emailId: emailData.data?.id,
        fileCount: sessionFiles.length,
      })

      return c.json({
        success: true,
        message: 'Email sent successfully!',
      })
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error
      }

      logger.error('Failed to send email', {
        error: error instanceof Error ? error.message : 'Unknown error',
        retrievalCode,
        recipientEmail,
      })

      throw new HTTPException(500, {
        message: 'An unexpected error occurred while sending the email',
      })
    }
  },
)

function generateEmailTemplate(
  retrievalCode: string,
  senderName?: string,
  recipientName?: string,
  message?: string,
  expiresAt?: Date | null,
  sessionFiles?: Array<{
    originalFilename: string
    isText: number
    fileSize: number
  }>,
): string {
  const baseUrl = process.env.FRONTEND_URL || 'https://dropply.pages.dev'
  const retrieveUrl = `${baseUrl}/retrieve?code=${retrievalCode}`

  const fileCount = sessionFiles?.length || 0
  const totalSize =
    sessionFiles?.reduce((sum, file) => sum + file.fileSize, 0) || 0

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getExpiryText = (): string => {
    if (!expiresAt) return 'These files will not expire.'
    const now = new Date()
    const timeDiff = expiresAt.getTime() - now.getTime()
    const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24))

    if (daysDiff <= 0) return 'These files have expired.'
    if (daysDiff === 1) return 'These files will expire tomorrow.'
    if (daysDiff <= 7) return `These files will expire in ${daysDiff} days.`
    return `These files will expire on ${expiresAt.toLocaleDateString()}.`
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Files shared with you</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .logo { color: #4C00FF; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
    .title { color: #333; font-size: 24px; font-weight: 600; margin: 0; }
    .content { background: #f8f9fa; border-radius: 12px; padding: 30px; margin: 20px 0; }
    .code-section { background: linear-gradient(135deg, #4C00FF, #6366f1); color: white; padding: 25px; border-radius: 12px; text-align: center; margin: 25px 0; }
    .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; margin: 10px 0; font-family: 'Courier New', monospace; }
    .retrieve-url { 
      background: rgba(255, 255, 255, 0.15); 
      padding: 12px 16px; 
      border-radius: 8px; 
      margin: 15px 0; 
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    .retrieve-url a { 
      color: #ffffff !important; 
      text-decoration: underline; 
      font-weight: 600;
      word-break: break-all;
      font-size: 16px;
    }
    .retrieve-url a:hover { color: #e0e0e0 !important; }
    .retrieve-instructions { 
      margin: 15px 0 0 0; 
      opacity: 0.9; 
      font-size: 14px;
      line-height: 1.4;
    }
    .button { 
      display: inline-block; 
      background: #4C00FF; 
      color: white !important; 
      padding: 16px 32px; 
      text-decoration: none; 
      border-radius: 8px; 
      font-weight: 600; 
      font-size: 16px; 
      margin: 20px 0; 
      transition: background-color 0.3s ease;
      box-shadow: 0 4px 12px rgba(76, 0, 255, 0.3);
    }
    .button:hover { background: #3d00cc; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(76, 0, 255, 0.4); }
    .file-list { background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border-left: 4px solid #4C00FF; }
    .file-info { margin: 10px 0; color: #666; display: flex; align-items: center; }
    .file-icon { margin-right: 8px; font-size: 16px; }
    .message-box { background: #e3f2fd; border-left: 4px solid #2196f3; padding: 15px; margin: 20px 0; border-radius: 4px; }
    .footer { text-align: center; color: #666; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    .expiry-warning { 
      background: #fff3cd; 
      border: 1px solid #ffeaa7; 
      color: #856404; 
      padding: 12px; 
      border-radius: 6px; 
      margin: 15px 0;
      display: flex;
      align-items: center;
    }
    .expiry-warning .icon { margin-right: 8px; font-size: 16px; }
    
    /* 移动端适配 */
    @media (max-width: 480px) {
      .container { padding: 15px; }
      .content { padding: 20px; }
      .code { font-size: 24px; letter-spacing: 2px; }
      .button { padding: 14px 24px; font-size: 14px; }
      .retrieve-url a { font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Dropply</div>
      <h1 class="title">${senderName ? `${senderName} shared` : 'Someone shared'} files with you</h1>
    </div>

    <div class="content">
      ${recipientName ? `<p>Hi ${recipientName},</p>` : '<p>Hi there,</p>'}
      
      <p>You've received ${fileCount} file${fileCount !== 1 ? 's' : ''} through Dropply${senderName ? ` from ${senderName}` : ''}!</p>
      
      ${message ? `<div class="message-box"><strong>Personal message:</strong><br>${message.replace(/\n/g, '<br>')}</div>` : ''}
      
      <div class="file-list">
        <h3 style="margin-top: 0; color: #333;">Files shared (${formatFileSize(totalSize)} total)</h3>
        ${
          sessionFiles
            ?.slice(0, 5)
            .map(
              (file) =>
                `<div class="file-info"><span class="file-icon">📄</span><span>${file.originalFilename} (${formatFileSize(file.fileSize)})</span></div>`,
            )
            .join('') || ''
        }
        ${fileCount > 5 ? `<div class="file-info"><span class="file-icon">📁</span><span>... and ${fileCount - 5} more file${fileCount - 5 !== 1 ? 's' : ''}</span></div>` : ''}
      </div>

      <div class="code-section">
        <h3 style="margin: 0 0 10px 0;">Retrieval Code</h3>
        <div class="code">${retrievalCode}</div>
        
        <div class="retrieve-instructions">
          Enter this code at:
        </div>
        <div class="retrieve-url">
          <a href="${baseUrl}/retrieve" target="_blank">${baseUrl}/retrieve</a>
        </div>
      </div>

      <div style="text-align: center;">
        <a href="${retrieveUrl}" class="button" target="_blank">Download Files Now</a>
      </div>

      <div class="expiry-warning">
        <span class="icon">⏰</span>
        <span>${getExpiryText()}</span>
      </div>
    </div>

    <div class="footer">
      <p>This email was sent by <strong>Dropply</strong> - a secure file sharing service.</p>
      <p>Files are encrypted and automatically deleted after expiration. No account required.</p>
      <p style="margin-top: 15px; font-size: 12px; color: #999;">
        If you didn't expect this email, you can safely ignore it. Need help? Visit our support page.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim()
}
