// useThemeController stamps data-theme on <html>; read it for resolveIdentityColor.
export function getResolvedTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}
