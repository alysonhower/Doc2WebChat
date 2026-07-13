import React from 'react'
import { popup_copy } from './copy'
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
          <span>{popup_copy.extension_label}</span>
          <h1>Doc2WebChat</h1>
        </div>
      </header>

      <section
        className={styles['popup__status']}
        aria-label={popup_copy.bridge_status_aria}
      >
        <span className={styles['popup__status-dot']} aria-hidden="true" />
        <div>
          <strong>{popup_copy.ready_title}</strong>
          <p>{popup_copy.ready_body}</p>
        </div>
      </section>

      {is_firefox ? (
        <section className={styles['popup__firefox']}>
          <div className={styles['popup__section-heading']}>
            <span>Firefox</span>
            <strong>{popup_copy.container_routing}</strong>
          </div>
          {!has_permission ? (
            <>
              <p>{popup_copy.container_permission_body}</p>
              <button
                type="button"
                onClick={request_permissions}
                className={styles['popup__enable-button']}
              >
                {popup_copy.enable_containers}
              </button>
            </>
          ) : (
            <label className={styles['popup__container-field']}>
              <span>{popup_copy.open_provider_tabs_in}</span>
              <select
                value={selected_container_id}
                onChange={handle_container_change}
                className={styles['popup__container-select']}
              >
                <option value="">{popup_copy.default_context}</option>
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
        <strong>{popup_copy.local_title}</strong>
        <p>{popup_copy.local_body}</p>
      </footer>
    </div>
  )
}
