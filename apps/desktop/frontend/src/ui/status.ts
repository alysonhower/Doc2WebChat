export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusPresentation {
  label: string
  tone: StatusTone
  guidance: string
  active: boolean
}

function humanizeStatus(status: string): string {
  const normalized = status.trim().replaceAll('_', '-').replaceAll('-', ' ')
  if (!normalized) return 'Unknown'
  return normalized[0].toUpperCase() + normalized.slice(1)
}

const interactionStatuses: Record<string, StatusPresentation> = {
  created: {
    label: 'Opening provider',
    tone: 'info',
    guidance: 'Preparing the prompt and opening it in your browser.',
    active: true
  },
  dispatched: {
    label: 'Opening provider',
    tone: 'info',
    guidance: 'Preparing the prompt and opening it in your browser.',
    active: true
  },
  prefilled: {
    label: 'Ready to submit',
    tone: 'info',
    guidance: 'Review the prompt in your browser, then submit it.',
    active: true
  },
  'awaiting-response': {
    label: 'Waiting for response',
    tone: 'info',
    guidance: 'The provider is generating a response in your browser.',
    active: true
  },
  'waiting-response': {
    label: 'Waiting for response',
    tone: 'info',
    guidance: 'The provider is generating a response in your browser.',
    active: true
  },
  'awaiting-import': {
    label: 'Ready to import',
    tone: 'info',
    guidance: 'Use Import Response beside the new browser response.',
    active: true
  },
  importing: {
    label: 'Importing response',
    tone: 'info',
    guidance: 'Copying the browser response into your local history.',
    active: true
  },
  completed: {
    label: 'Imported',
    tone: 'success',
    guidance: 'The browser response was imported successfully.',
    active: false
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    guidance:
      'The interaction could not finish. Review the error and try again.',
    active: false
  },
  expired: {
    label: 'Expired',
    tone: 'warning',
    guidance: 'This browser handoff expired. Start a new chat to try again.',
    active: false
  }
}

const ocrStatuses: Record<string, StatusPresentation> = {
  pending: {
    label: 'Preparing',
    tone: 'info',
    guidance: 'Preparing the OCR batch.',
    active: true
  },
  discovering: {
    label: 'Finding files',
    tone: 'info',
    guidance: 'Finding supported files in the input folder.',
    active: true
  },
  planning: {
    label: 'Checking outputs',
    tone: 'info',
    guidance: 'Checking output paths and existing files.',
    active: true
  },
  'starting-server': {
    label: 'Starting OCR',
    tone: 'info',
    guidance: 'Starting the local OCR service.',
    active: true
  },
  queued: {
    label: 'Queued',
    tone: 'neutral',
    guidance: 'Waiting to process this file.',
    active: true
  },
  running: {
    label: 'Processing',
    tone: 'info',
    guidance: 'Converting documents and extracting searchable text.',
    active: true
  },
  processing: {
    label: 'Processing',
    tone: 'info',
    guidance: 'Running OCR on this file.',
    active: true
  },
  writing: {
    label: 'Writing PDF',
    tone: 'info',
    guidance: 'Writing the searchable PDF safely.',
    active: true
  },
  extracting: {
    label: 'Extracting text',
    tone: 'info',
    guidance: 'Reading searchable text from the completed PDF.',
    active: true
  },
  persisting: {
    label: 'Saving result',
    tone: 'info',
    guidance: 'Saving the OCR result to the local library.',
    active: true
  },
  'awaiting-overwrite': {
    label: 'Review required',
    tone: 'warning',
    guidance: 'Confirm whether the listed output files may be replaced.',
    active: false
  },
  completed: {
    label: 'Completed',
    tone: 'success',
    guidance: 'OCR completed successfully.',
    active: false
  },
  'completed-with-errors': {
    label: 'Completed with issues',
    tone: 'warning',
    guidance: 'Some files could not be processed. Review the results below.',
    active: false
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    guidance: 'OCR could not finish. Review the error and try again.',
    active: false
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'warning',
    guidance: 'The application stopped before OCR completed.',
    active: false
  },
  skipped: {
    label: 'Skipped',
    tone: 'neutral',
    guidance: 'This file was intentionally skipped.',
    active: false
  }
}

function fallback(status: string): StatusPresentation {
  return {
    label: humanizeStatus(status),
    tone: 'neutral',
    guidance: '',
    active: false
  }
}

export function getInteractionStatusPresentation(
  status: string
): StatusPresentation {
  return (
    interactionStatuses[status.trim().toLowerCase().replaceAll('_', '-')] ??
    fallback(status)
  )
}

export function getOcrStatusPresentation(status: string): StatusPresentation {
  return (
    ocrStatuses[status.trim().toLowerCase().replaceAll('_', '-')] ??
    fallback(status)
  )
}
