import { useState } from 'react'
import { useDesktopState } from './hooks/useDesktopState'
import { ChatView } from './components/ChatView'
import { DocumentsView } from './components/DocumentsView'
import { HistoryView } from './components/HistoryView'
import { PromptLibraryView } from './components/PromptLibraryView'
import {
  ChatIcon,
  DocumentIcon,
  HistoryIcon,
  LibraryIcon
} from './components/Icons'

type View = 'documents' | 'chat' | 'history' | 'prompts'

const navigation: Array<{
  id: View
  label: string
  icon: typeof DocumentIcon
}> = [
  { id: 'documents', label: 'Documents', icon: DocumentIcon },
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'history', label: 'History', icon: HistoryIcon },
  { id: 'prompts', label: 'Prompt Library', icon: LibraryIcon }
]

export default function App() {
  const [view, setView] = useState<View>('documents')
  const desktop = useDesktopState()

  if (desktop.loading && !desktop.bootstrap) {
    return (
      <main className="startup">
        <div className="brand-mark">
          D<span>2</span>
        </div>
        <div className="startup__line" />
        <p>Starting local workspace…</p>
      </main>
    )
  }
  if (!desktop.bootstrap) {
    return (
      <main className="startup">
        <div className="brand-mark">
          D<span>2</span>
        </div>
        <h1>Desktop service unavailable</h1>
        <p>{desktop.error}</p>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void desktop.reload()}
        >
          Try again
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
            D<span>2</span>
          </div>
          <div>
            <strong>Doc2WebChat</strong>
            <small>Local document workspace</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? 'is-active' : ''}
                aria-current={view === item.id ? 'page' : undefined}
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
                ? `${connectedCount} browser${connectedCount === 1 ? '' : 's'} connected`
                : 'Extension offline'}
            </strong>
            <small>Bridge · 127.0.0.1:55155</small>
          </div>
        </div>
        <div className="privacy-note">
          <span>Local first</span>
          <p>Documents and conversations stay on this computer.</p>
        </div>
      </aside>
      <main className="main-content">
        {desktop.error ? (
          <div className="global-alert" role="alert">
            <span>{desktop.error}</span>
            <button type="button" onClick={desktop.clearError}>
              Dismiss
            </button>
          </div>
        ) : null}
        {view === 'documents' ? (
          <DocumentsView
            documents={documents}
            events={desktop.events}
            activeJob={desktop.activeJob}
            onJobStarted={desktop.setActiveJob}
            onRefresh={desktop.refreshDocuments}
          />
        ) : null}
        {view === 'chat' ? (
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
        ) : null}
        {view === 'history' ? (
          <HistoryView history={history} providers={providers} />
        ) : null}
        {view === 'prompts' ? (
          <PromptLibraryView
            prompts={prompts}
            onPromptsChange={desktop.replacePrompts}
          />
        ) : null}
      </main>
    </div>
  )
}
