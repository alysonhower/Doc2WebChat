import { useState } from 'react'
import { useDesktopState } from './hooks/useDesktopState'
import { ChatView } from './components/ChatView'
import { DocumentsView } from './components/DocumentsView'
import { HistoryView } from './components/HistoryView'
import { PromptLibraryView } from './components/PromptLibraryView'
import {
  BrandIcon,
  ChatIcon,
  DarkThemeIcon,
  DocumentIcon,
  HistoryIcon,
  LibraryIcon,
  LightThemeIcon,
  SystemThemeIcon
} from './components/Icons'
import { type ThemePreference, useTheme } from './hooks/useTheme'

type View = 'documents' | 'chat' | 'history' | 'prompts'

const navigation: Array<{
  id: View
  label: string
  icon: typeof DocumentIcon
}> = [
  { id: 'documents', label: 'Documentos', icon: DocumentIcon },
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'history', label: 'Threads', icon: HistoryIcon },
  { id: 'prompts', label: 'Biblioteca de prompts', icon: LibraryIcon }
]

const themes: Array<{
  id: ThemePreference
  label: string
  icon: typeof SystemThemeIcon
}> = [
  { id: 'system', label: 'Tema do sistema', icon: SystemThemeIcon },
  { id: 'light', label: 'Tema claro', icon: LightThemeIcon },
  { id: 'dark', label: 'Tema escuro', icon: DarkThemeIcon }
]

export default function App() {
  const [view, setView] = useState<View>('documents')
  const desktop = useDesktopState()
  const theme = useTheme()

  if (desktop.loading && !desktop.bootstrap) {
    return (
      <main className="startup">
        <div className="brand-mark">
          <BrandIcon />
        </div>
        <div className="startup__line" />
        <p>Iniciando espaço de trabalho local…</p>
      </main>
    )
  }
  if (!desktop.bootstrap) {
    return (
      <main className="startup">
        <div className="brand-mark">
          <BrandIcon />
        </div>
        <h1>Serviço desktop indisponível</h1>
        <p>{desktop.error}</p>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void desktop.reload()}
        >
          Tentar novamente
        </button>
      </main>
    )
  }

  const { documents, providers, browsers, history, prompts, preferences } =
    desktop.bootstrap
  const connectedCount = browsers.filter(
    (browser) => browser.connected !== false
  ).length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BrandIcon />
          </div>
          <div>
            <strong>Doc2WebChat</strong>
            <small>Espaço de documentos local</small>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? 'is-active' : ''}
                aria-label={item.label}
                aria-current={view === item.id ? 'page' : undefined}
                aria-controls={`view-${item.id}`}
                title={item.label}
                onClick={() => setView(item.id)}
              >
                <Icon />
                <span>{item.label}</span>
                {item.id === 'documents' && documents.length ? (
                  <small>{documents.length}</small>
                ) : null}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-status">
          <div
            className={
              connectedCount ? 'connection-dot is-online' : 'connection-dot'
            }
          />
          <div>
            <strong>
              {connectedCount
                ? `${connectedCount} ${connectedCount === 1 ? 'navegador conectado' : 'navegadores conectados'}`
                : 'Extensão offline'}
            </strong>
            <small>Bridge · 127.0.0.1:55155</small>
          </div>
        </div>
        <div className="privacy-note">
          <span>Local por padrão</span>
          <p>Documentos e Threads ficam neste computador.</p>
        </div>
        <div className="theme-switcher" role="group" aria-label="Tema">
          {themes.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-pressed={theme.preference === item.id}
                title={item.label}
                onClick={() => theme.setPreference(item.id)}
              >
                <Icon />
              </button>
            )
          })}
        </div>
      </aside>
      <main className="main-content">
        {desktop.error ? (
          <div className="global-alert" role="alert">
            <span>{desktop.error}</span>
            <button type="button" onClick={desktop.clearError}>
              Dispensar
            </button>
          </div>
        ) : null}
        <section
          id="view-documents"
          className="app-view-panel"
          data-testid="view-panel-documents"
          hidden={view !== 'documents'}
        >
          <DocumentsView
            documents={documents}
            events={desktop.events}
            activeJob={desktop.activeJob}
            onJobStarted={desktop.setActiveJob}
            onRefresh={desktop.refreshDocuments}
            onDelete={desktop.deleteDocument}
            onDeleteMany={desktop.deleteDocuments}
          />
        </section>
        <section
          id="view-chat"
          className="app-view-panel"
          data-testid="view-panel-chat"
          hidden={view !== 'chat'}
        >
          <ChatView
            documents={documents}
            providers={providers}
            browsers={browsers}
            history={history}
            prompts={prompts}
            initialProviderId={preferences.selectedProviderId}
            initialBrowserId={preferences.selectedBrowserInstanceId}
            initialReuseTab={
              preferences.reuseTab ??
              (preferences.selectedProviderId
                ? preferences.providerSettings?.[preferences.selectedProviderId]
                    ?.reuse_last_tab
                : undefined)
            }
            initialSettings={preferences.providerSettings}
            initialProviderUrls={preferences.providerUrls}
            onRefreshHistory={desktop.refreshHistory}
          />
        </section>
        <section
          id="view-history"
          className="app-view-panel"
          data-testid="view-panel-history"
          hidden={view !== 'history'}
        >
          <HistoryView
            history={history}
            providers={providers}
            onDelete={desktop.deleteInteraction}
            onDeleteMany={desktop.deleteInteractions}
          />
        </section>
        <section
          id="view-prompts"
          className="app-view-panel"
          data-testid="view-panel-prompts"
          hidden={view !== 'prompts'}
        >
          <PromptLibraryView
            prompts={prompts}
            onPromptsChange={desktop.replacePrompts}
          />
        </section>
      </main>
    </div>
  )
}
