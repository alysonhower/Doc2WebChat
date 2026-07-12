import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, type ThemePreference, useTheme } from './useTheme'

function mockColorScheme(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    media: '(prefers-color-scheme: dark)',
    get matches() {
      return matches
    },
    onchange: null,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener)
      }
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener)
      }
    ),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  } as unknown as MediaQueryList

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media)
  )

  return {
    setDark(next: boolean) {
      matches = next
      const event = { matches: next, media: media.media } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
    media
  }
}

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['light', false],
    ['dark', true]
  ] as const)('defaults to the %s system theme', (expected, systemDark) => {
    mockColorScheme(systemDark)
    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('system')
    expect(result.current.resolvedTheme).toBe(expected)
    expect(document.documentElement).toHaveAttribute('data-theme', expected)
  })

  it.each(['system', 'light', 'dark'] satisfies ThemePreference[])(
    'persists the %s preference',
    (preference) => {
      mockColorScheme(false)
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setPreference(preference))

      expect(result.current.preference).toBe(preference)
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(preference)
    }
  )

  it('loads a valid saved override and ignores system changes', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const colorScheme = mockColorScheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => colorScheme.setDark(true))
    act(() => colorScheme.setDark(false))

    expect(result.current.preference).toBe('dark')
    expect(result.current.resolvedTheme).toBe('dark')
  })

  it('reacts to OS changes while following the system theme', () => {
    const colorScheme = mockColorScheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => colorScheme.setDark(true))

    expect(result.current.resolvedTheme).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('falls back to system when stored data is invalid', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    mockColorScheme(false)

    const { result } = renderHook(() => useTheme())

    expect(result.current.preference).toBe('system')
    expect(result.current.resolvedTheme).toBe('light')
  })
})
