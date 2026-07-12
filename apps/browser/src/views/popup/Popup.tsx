import React from 'react'
import styles from './Popup.module.scss'
import { use_firefox_containers } from './use-firefox-containers'

export const Popup: React.FC = () => {
  const {
    is_firefox,
    has_permission,
    containers,
    selected_container_id,
    request_permissions,
    handle_container_change
  } = use_firefox_containers()

  return (
    <div className={styles.popup}>
      <header className={styles['popup__header']}>
        <img src="icons/icon-48.png" alt="" aria-hidden="true" />
        <div>
          <span>Browser extension</span>
          <h1>Doc2WebChat</h1>
        </div>
      </header>

      <section
        className={styles['popup__status']}
        aria-label="Browser bridge status"
      >
        <span className={styles['popup__status-dot']} aria-hidden="true" />
        <div>
          <strong>Ready for local handoffs</strong>
          <p>
            Keep the desktop app open, then start a chat from its workspace.
          </p>
        </div>
      </section>

      {is_firefox ? (
        <section className={styles['popup__firefox']}>
          <div className={styles['popup__section-heading']}>
            <span>Firefox</span>
            <strong>Container routing</strong>
          </div>
          {!has_permission ? (
            <>
              <p>
                Allow container access to open provider tabs in a selected
                Firefox Container.
              </p>
              <button
                type="button"
                onClick={request_permissions}
                className={styles['popup__enable-button']}
              >
                Enable containers
              </button>
            </>
          ) : (
            <label className={styles['popup__container-field']}>
              <span>Open provider tabs in</span>
              <select
                value={selected_container_id}
                onChange={handle_container_change}
                className={styles['popup__container-select']}
              >
                <option value="">Default browser context</option>
                {containers.map((container) => (
                  <option
                    key={container.cookieStoreId}
                    value={container.cookieStoreId}
                  >
                    {container.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      ) : null}

      <footer className={styles['popup__footer']}>
        <strong>Local by design</strong>
        <p>Prompts move directly between this browser and your desktop app.</p>
      </footer>
    </div>
  )
}
