import { useCallback, useEffect, useMemo, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

export const THEME_STORAGE_KEY = 'doc2webchat-theme'
const DARK_THEME_QUERY = '(prefers-color-scheme: dark)'

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

function getStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(stored) ? stored : 'system'
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia?.(DARK_THEME_QUERY).matches ? 'dark' : 'light'
}

export function useTheme() {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(getStoredPreference)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  useEffect(() => {
    if (!window.matchMedia) return

    const media = window.matchMedia(DARK_THEME_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }

    setSystemTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  const resolvedTheme = useMemo<ResolvedTheme>(
    () => (preference === 'system' ? systemTheme : preference),
    [preference, systemTheme]
  )

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const setPreference = useCallback((next: ThemePreference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
    setPreferenceState(next)
  }, [])

  return { preference, resolvedTheme, setPreference }
}
