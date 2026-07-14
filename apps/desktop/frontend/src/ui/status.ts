export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusPresentation {
  label: string
  tone: StatusTone
  guidance: string
  active: boolean
}

interface OcrEventStatus {
  stage?: unknown
  status?: unknown
  type?: unknown
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

const ocrStatuses: Record<string, StatusPresentation> = {
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
  processing: {
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
  'awaiting-overwrite': {
    label: 'Revisão necessária',
    tone: 'warning',
    guidance:
      'Confirme se os arquivos de saída listados podem ser substituídos.',
    active: false
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

export function getOcrEventStatusPresentation(
  event: OcrEventStatus
): StatusPresentation {
  const stage = String(event.stage ?? event.status ?? event.type ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (stage === 'job-finished') {
    return getOcrStatusPresentation(String(event.status ?? 'completed'))
  }
  const statusAliases: Record<string, string> = {
    discovery: 'discovering',
    'plan-validation': 'planning',
    'server-startup': 'starting-server',
    progress: 'running',
    'job-failed': 'failed',
    'overwrite-confirmation-required': 'awaiting-overwrite'
  }
  return getOcrStatusPresentation(statusAliases[stage] ?? stage)
}
