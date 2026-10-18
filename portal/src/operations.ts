// Names for the care actions already in the portal, used as trace labels.
export function careOperation(method: string, pathname: string): string {
  const path = pathname.replace(/\/api\/files\/.*$/, '/api/files')
  const names: Record<string, string> = {
    'GET /api/data': 'Load the care record',
    'PUT /api/data': 'Save the care record',
    'POST /api/upload': 'Upload a file',
    'POST /api/read-prescription': 'Read a prescription',
    'POST /api/transcribe': 'Transcribe a voice sample',
    'GET /api/transcripts': 'Load what was heard',
    'POST /api/transcripts': 'Save what was heard',
    'GET /api/doses': 'Load doses',
    'POST /api/doses': 'Record a dose',
    'GET /api/prices': 'Load pharmacy prices',
    'POST /api/prices': 'Check pharmacy prices',
    'GET /api/imessage': 'Load family texts',
    'GET /api/glasses': 'Update the glasses',
    'POST /api/glasses/seen': 'Message seen on glasses',
    'GET /api/files': 'Open an uploaded file',
    'DELETE /api/files': 'Remove an uploaded file',
  }
  return names[`${method} ${path}`] ?? `${method} ${path}`
}
