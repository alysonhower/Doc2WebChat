import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const DocumentIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M6 2.75h8l4 4V21.25H6z" />
    <path d="M14 2.75v4h4M9 12h6M9 16h6" />
  </IconBase>
)
export const ChatIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 4h16v12H8l-4 4z" />
    <path d="M8 9h8M8 12h5" />
  </IconBase>
)
export const HistoryIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </IconBase>
)
export const LibraryIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 4.5h5v15H4zM9 4.5h5v15H9zM16 5l4 14-4 1z" />
  </IconBase>
)
export const FolderIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M3 6.5h7l2 2h9v10H3z" />
  </IconBase>
)
export const ArrowIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M5 12h14M14 7l5 5-5 5" />
  </IconBase>
)
export const RefreshIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M20 6v5h-5M4 18v-5h5" />
    <path d="M6.1 9A7 7 0 0 1 18 6l2 5M18 15a7 7 0 0 1-12 3l-2-5" />
  </IconBase>
)
export const SparkIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m12 2 1.3 5.1L18 9l-4.7 1.9L12 16l-1.3-5.1L6 9l4.7-1.9zM19 15l.6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6z" />
  </IconBase>
)
export const TrashIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
  </IconBase>
)
