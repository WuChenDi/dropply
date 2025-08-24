# Dropply

A secure file sharing platform built with Next.js and Cloudflare Workers. Share files instantly with military-grade encryption, no accounts required.

## Features

- **No Account Required**: Share files instantly without registration
- **End-to-End Encryption**: Military-grade security for all shared content
- **Auto-Delete**: Files automatically delete after expiration
- **Text & File Support**: Share both text snippets and files
- **Large File Support**: Multipart upload for files up to 5GB
- **Email Sharing**: Send retrieval codes directly via email
- **TOTP Authentication**: Optional two-factor authentication for uploads
- **Mobile Responsive**: Works seamlessly on all devices
- **Dark/Light Mode**: Adaptive theme support

## Architecture

### Backend (Cloudflare Workers)
- **Runtime**: Cloudflare Workers with Hono.js framework
- **Storage**: Cloudflare R2 for file storage
- **Database**: D1 (SQLite) or LibSQL for metadata
- **Email**: Resend API for email sharing
- **Authentication**: JWT tokens and TOTP support

### Frontend (Next.js)
- **Framework**: Next.js 14 with TypeScript
- **UI Library**: Custom component library with Tailwind CSS
- **State Management**: React hooks with custom API layer
- **File Upload**: Multi-threaded upload with progress tracking
- **Animations**: Smooth transitions and loading states

## Project Structure

```
dropply/
├── apps/
│   ├── api/           # Cloudflare Workers API
│   └── web/           # Next.js frontend
├── packages/
│   ├── tsconfig/      # Shared TypeScript configs
│   └── ui/            # Shared UI components
└── turbo.json         # Monorepo configuration
```

### Backend Structure (`apps/api/`)

```
src/
├── cron/              # Scheduled cleanup tasks
├── database/          # Database schema and migrations  
├── lib/               # Shared utilities and helpers
├── routes/            # API route handlers
├── types/             # TypeScript type definitions
├── global.ts          # Global logger setup
└── index.ts           # Main application entry
```

### Frontend Structure (`apps/web/`)

```
src/
├── app/               # Next.js app router pages
├── components/        # Reusable React components
├── hooks/             # Custom React hooks
└── lib/               # Frontend utilities and API client
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm package manager
- Cloudflare account (for deployment)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/WuChenDi/dropply.git
cd dropply
```

2. Install dependencies:
```bash
pnpm install
```

3. Set up environment variables:

**Backend (`.env` in `apps/api/`):**
```env
# Database
DB_TYPE=libsql
LIBSQL_URL=file:./database/data.db
LIBSQL_AUTH_TOKEN=your_token

# Security
JWT_SECRET=your_jwt_secret
REQUIRE_TOTP=false
TOTP_SECRETS=device1:SECRET1,device2:SECRET2

# Email (optional)
ENABLE_EMAIL_SHARE=true
RESEND_API_KEY=your_resend_key
RESEND_FROM_EMAIL=noreply@yourdomain.com
```

**Frontend (`.env.local` in `apps/web/`):**
```env
NEXT_PUBLIC_API_URL=http://localhost:8787
```

### Development

1. Start the backend:
```bash
cd apps/api
pnpm dev
```

2. Start the frontend:
```bash
cd apps/web
pnpm dev
```

3. Access the application at `http://localhost:3000`

### Deployment

#### Backend (Cloudflare Workers)

1. Configure `wrangler.toml` with your Cloudflare settings
2. Deploy to Cloudflare:
```bash
cd apps/api
pnpm deploy
```

#### Frontend (Vercel/Netlify)

1. Connect your repository to your preferred platform
2. Set the build command: `pnpm build`
3. Set the output directory: `apps/web/.next`
4. Configure environment variables

## API Endpoints

### Configuration
- `GET /api/config` - Get server configuration

### File Management
- `POST /api/chest` - Create new upload session
- `POST /api/chest/:sessionId/upload` - Upload files
- `POST /api/chest/:sessionId/complete` - Finalize upload
- `POST /api/chest/:sessionId/multipart/create` - Create multipart upload
- `PUT /api/chest/:sessionId/multipart/:fileId/part/:partNumber` - Upload part
- `POST /api/chest/:sessionId/multipart/:fileId/complete` - Complete multipart

### Retrieval
- `GET /api/retrieve/:code` - Get files by retrieval code
- `GET /api/download/:fileId` - Download specific file

### Email Sharing
- `POST /api/email/share` - Send retrieval code via email

## Database Schema

### Sessions Table
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- UUID v4
  retrieval_code TEXT UNIQUE,   -- 6-character code
  upload_complete INTEGER DEFAULT 0,
  expires_at INTEGER,           -- Unix timestamp
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);
```

### Files Table
```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,          -- UUID v4
  session_id TEXT NOT NULL,     -- Foreign key
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_extension TEXT,
  is_text INTEGER DEFAULT 0,   -- 1 for text items
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);
```

## Security Features

### Authentication
- JWT-based session tokens with expiration
- Optional TOTP (Time-based One-Time Password) protection
- Secure token validation for all operations

### Data Protection
- Files stored in encrypted Cloudflare R2 buckets
- Automatic cleanup of expired content
- Soft deletion with permanent cleanup jobs
- No persistent user data storage

### Access Control
- Time-limited download tokens
- Session-based file access
- Automatic expiration enforcement

## Configuration Options

### File Upload Limits
- Max file size: 5GB per file
- Chunk size: 20MB for multipart uploads
- Concurrent uploads: 3 files simultaneously

### Expiry Options
- 1 Day
- 3 Days  
- 1 Week
- 2 Weeks
- Permanent (never expires)

### TOTP Setup
Support for multiple TOTP devices using standard authenticator apps:
- Google Authenticator
- Authy
- 1Password
- Any RFC 6238 compatible app

## Monitoring & Maintenance

### Scheduled Tasks
- **Cleanup Job**: Runs periodically to remove expired sessions and files
- **Incomplete Session Cleanup**: Removes sessions older than 48 hours without completion

### Logging
- Structured logging with timestamp and context
- Request/response logging
- Error tracking with stack traces
- Performance metrics

## 📜 License

[MIT](./LICENSE) License &copy; 2025-PRESENT [wudi](https://github.com/WuChenDi)
