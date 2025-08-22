'use client'

import { useState, useRef, DragEvent } from 'react'
import { Upload, File, X, FolderOpen, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib'

interface FileUploadProps {
  onFilesChange: (files: File[]) => void
  files: File[]
}

export function FileUpload({ onFilesChange, files }: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target) {
      setIsDragOver(false)
    }
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    const newFiles = [...files, ...droppedFiles]
    onFilesChange(newFiles)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || [])
    const newFiles = [...files, ...selectedFiles]
    onFilesChange(newFiles)
  }

  const removeFile = (index: number) => {
    const newFiles = files.filter((_, i) => i !== index)
    onFilesChange(newFiles)
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getFileIcon = (fileName: string) => {
    const extension = fileName.split('.').pop()?.toLowerCase()

    // You could expand this with more specific icons based on file type
    return <File size={16} className="text-purple-500" />
  }

  return (
    <div className="w-full space-y-4">
      {/* Drop Zone */}
      <div
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200 cursor-pointer',
          'hover:bg-background/50',
          isDragOver
            ? 'border-primary bg-primary/5 scale-[1.02]'
            : 'border-border/40 hover:border-border/60',
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="space-y-4">
          <div
            className={cn(
              'mx-auto w-16 h-16 rounded-full flex items-center justify-center transition-all duration-200',
              isDragOver ? 'bg-primary/10 scale-110' : 'bg-muted/50',
            )}
          >
            {isDragOver ? (
              <Upload size={24} className="text-primary" />
            ) : (
              <FolderOpen size={24} className="text-muted-foreground" />
            )}
          </div>

          <div>
            <p className="text-lg font-medium text-foreground mb-1">
              {isDragOver
                ? 'Drop files here'
                : 'Drop files here or click to browse'}
            </p>
            <p className="text-sm text-muted-foreground">
              Select multiple files to share
            </p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* Selected Files */}
      {files.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-muted-foreground" />
            <h4 className="font-semibold text-foreground">
              Selected Files ({files.length})
            </h4>
          </div>

          <div className="space-y-2">
            {files.map((file, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-center justify-between p-3 rounded-lg',
                  'border border-border/30 bg-background/30 backdrop-blur-sm',
                  'transition-all duration-200 hover:bg-background/50',
                )}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30">
                    {getFileIcon(file.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    FILE
                  </Badge>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFile(index)
                    }}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-8 w-8 p-0 text-muted-foreground',
                      'hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30',
                      'transition-colors duration-200',
                    )}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
