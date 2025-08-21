// 生成 UUID v4
export function generateUUID(): string {
  return crypto.randomUUID()
}

// 生成6位字母数字检索码
export function generateRetrievalCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// 验证 UUID 格式
export function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(uuid)
}

// 验证检索码格式
export function isValidRetrievalCode(code: string): boolean {
  const codeRegex = /^[A-Z0-9]{6}$/
  return codeRegex.test(code)
}

// 计算过期时间
export function calculateExpiry(validityDays: number): Date | null {
  if (validityDays === -1) {
    return null // 永久
  }
  return new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000)
}

// 获取文件扩展名
export function getFileExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.substring(lastDot + 1) : null
}
