import type { OcrEvent } from '../api/contracts'
import type {
  OcrDocumentStatus,
  OcrFileStage,
  OcrFileStatus,
  OcrJobStatus
} from '../api/ocr-contract.generated'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusPresentation {
  label: string
  tone: StatusTone
  guidance: string
  active: boolean
}

function humanizeStatus(status: string): string {
  const normalized = status.trim().replaceAll('_', '-').replaceAll('-', ' ')
  if (!normalized) return 'Desconhecido'
  return 'Status desconhecido'
}

const interactionStatuses: Record<string, StatusPresentation> = {
  created: {
    label: 'Abrindo provedor',
    tone: 'info',
    guidance: 'Preparando o prompt para abri-lo no navegador.',
    active: true
  },
  dispatched: {
    label: 'Abrindo provedor',
    tone: 'info',
    guidance: 'Preparando o prompt para abri-lo no navegador.',
    active: true
  },
  prefilled: {
    label: 'Pronta para enviar',
    tone: 'info',
    guidance: 'Revise o prompt no navegador e envie quando estiver pronto.',
    active: true
  },
  'awaiting-response': {
    label: 'Aguardando resposta',
    tone: 'info',
    guidance: 'O provedor está gerando uma resposta no navegador.',
    active: true
  },
  'waiting-response': {
    label: 'Aguardando resposta',
    tone: 'info',
    guidance: 'O provedor está gerando uma resposta no navegador.',
    active: true
  },
  'awaiting-import': {
    label: 'Pronta para importar',
    tone: 'info',
    guidance: 'Use Importar resposta ao lado da nova resposta no navegador.',
    active: true
  },
  importing: {
    label: 'Importando resposta',
    tone: 'info',
    guidance: 'Copiando a resposta do navegador para esta Thread.',
    active: true
  },
  completed: {
    label: 'Importada',
    tone: 'success',
    guidance: 'A resposta do navegador foi importada com sucesso.',
    active: false
  },
  failed: {
    label: 'Falhou',
    tone: 'danger',
    guidance:
      'Não foi possível concluir a Thread. Revise o erro e tente novamente.',
    active: false
  },
  expired: {
    label: 'Expirada',
    tone: 'warning',
    guidance:
      'Esta transferência expirou. Inicie um novo Chat para tentar novamente.',
    active: false
  }
}

type OcrPresentationStatus =
  | OcrJobStatus
  | OcrDocumentStatus
  | OcrFileStage
  | OcrFileStatus

const ocrStatuses = {
  pending: {
    label: 'Preparando',
    tone: 'info',
    guidance: 'Preparando o lote de OCR.',
    active: true
  },
  discovering: {
    label: 'Procurando arquivos',
    tone: 'info',
    guidance: 'Procurando arquivos compatíveis na pasta de entrada.',
    active: true
  },
  planning: {
    label: 'Verificando saídas',
    tone: 'info',
    guidance: 'Verificando caminhos de saída e arquivos existentes.',
    active: true
  },
  'awaiting-overwrite': {
    label: 'Revisão necessária',
    tone: 'warning',
    guidance:
      'Confirme se os arquivos de saída listados podem ser substituídos.',
    active: false
  },
  'overwrite-claimed': {
    label: 'Confirmando substituição',
    tone: 'info',
    guidance: 'Reservando os arquivos aprovados para uma nova tentativa.',
    active: true
  },
  'overwrite-confirmed': {
    label: 'Substituição confirmada',
    tone: 'success',
    guidance: 'A substituição dos arquivos existentes foi autorizada.',
    active: false
  },
  'overwrite-declined': {
    label: 'Substituição recusada',
    tone: 'neutral',
    guidance: 'Os arquivos existentes foram preservados.',
    active: false
  },
  'starting-server': {
    label: 'Iniciando OCR',
    tone: 'info',
    guidance: 'Iniciando o serviço local de OCR.',
    active: true
  },
  queued: {
    label: 'Na fila',
    tone: 'neutral',
    guidance: 'Aguardando o processamento deste arquivo.',
    active: true
  },
  running: {
    label: 'Processando',
    tone: 'info',
    guidance: 'Convertendo documentos e extraindo texto pesquisável.',
    active: true
  },
  'ocr-processing': {
    label: 'Processando',
    tone: 'info',
    guidance: 'Executando OCR neste arquivo.',
    active: true
  },
  writing: {
    label: 'Gravando PDF',
    tone: 'info',
    guidance: 'Gravando o PDF pesquisável com segurança.',
    active: true
  },
  extracting: {
    label: 'Extraindo texto',
    tone: 'info',
    guidance: 'Lendo o texto pesquisável do PDF concluído.',
    active: true
  },
  persisting: {
    label: 'Salvando resultado',
    tone: 'info',
    guidance: 'Salvando o resultado do OCR na biblioteca local.',
    active: true
  },
  completed: {
    label: 'Concluído',
    tone: 'success',
    guidance: 'OCR concluído com sucesso.',
    active: false
  },
  'completed-with-errors': {
    label: 'Concluído com problemas',
    tone: 'warning',
    guidance:
      'Alguns arquivos não puderam ser processados. Revise os resultados abaixo.',
    active: false
  },
  failed: {
    label: 'Falhou',
    tone: 'danger',
    guidance: 'O OCR não pôde ser concluído. Revise o erro e tente novamente.',
    active: false
  },
  interrupted: {
    label: 'Interrompido',
    tone: 'warning',
    guidance: 'O aplicativo foi encerrado antes da conclusão do OCR.',
    active: false
  },
  skipped: {
    label: 'Ignorado',
    tone: 'neutral',
    guidance: 'Este arquivo foi ignorado conforme solicitado.',
    active: false
  },
  'ocr-failed': {
    label: 'OCR falhou',
    tone: 'danger',
    guidance: 'O mecanismo de OCR não conseguiu processar este arquivo.',
    active: false
  },
  'write-failed': {
    label: 'Falha ao gravar PDF',
    tone: 'danger',
    guidance: 'O PDF pesquisável não pôde ser gravado no destino.',
    active: false
  },
  'extract-failed': {
    label: 'Falha ao extrair texto',
    tone: 'danger',
    guidance: 'O PDF não produziu texto pesquisável válido.',
    active: false
  },
  'processing-failed': {
    label: 'Falha no processamento',
    tone: 'danger',
    guidance: 'O arquivo falhou em uma etapa inesperada do processamento.',
    active: false
  },
  'batch-failed': {
    label: 'Lote interrompido',
    tone: 'danger',
    guidance: 'O arquivo não foi concluído porque o lote foi interrompido.',
    active: false
  }
} satisfies Record<OcrPresentationStatus, StatusPresentation>

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

export function getOcrStatusPresentation(
  status: OcrPresentationStatus
): StatusPresentation {
  return ocrStatuses[status]
}

export function getOcrEventStatusPresentation(
  event: OcrEvent
): StatusPresentation {
  const { stage } = event
  switch (stage) {
    case 'discovery':
      return getOcrStatusPresentation('discovering')
    case 'plan-validation':
      return getOcrStatusPresentation('planning')
    case 'overwrite-confirmation-required':
      return getOcrStatusPresentation('awaiting-overwrite')
    case 'queued':
    case 'ocr-processing':
    case 'writing':
    case 'extracting':
    case 'persisting':
    case 'completed':
    case 'failed':
    case 'skipped':
      return getOcrStatusPresentation(stage)
    case 'server-startup':
      return getOcrStatusPresentation('starting-server')
    case 'progress':
      return getOcrStatusPresentation('running')
    case 'job-finished':
      return getOcrStatusPresentation(event.status)
    case 'job-failed':
      return getOcrStatusPresentation('failed')
    default:
      return assertNever(stage)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable OCR status: ${String(value)}`)
}
