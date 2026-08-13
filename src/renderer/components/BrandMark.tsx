// The AI Code Conductor brand monogram — the C-ring (blue->light gradient) with
// the A (azure) and I (light) inside it, the same mark as the app icon and the
// boot splash. Replaces the earlier radial starburst so the onboarding/tour
// carries the product brand. Paths are the monogram subset of the brand SVG
// (resources/splash logo), cropped to a tight square viewBox. Sizing + the
// drop-shadow come from CSS (`.ob-root .mark` / `.ob-root .blogo`); fills are
// set here because this is a filled mark, not the stroked line-art it replaced.

// Module-level counter gives each rendered instance a unique gradient id, so two
// marks on one screen (header .blogo + hero .mark) do not collide on url(#id).
let uid = 0

export function BrandMark({ className }: { className?: string }) {
  const gid = `ccc-mono-${uid++}`
  return (
    <svg className={className} viewBox="61 59 210 210" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0%" y1="92%" x2="85%" y2="8%">
          <stop offset="0%" stopColor="#2F9BFF" />
          <stop offset="52%" stopColor="#8fb8e6" />
          <stop offset="100%" stopColor="#d9dbe0" />
        </linearGradient>
      </defs>
      <path d="M 181.342 69.409 C 135.839 78.114, 102.087 117.721, 102.011 162.500 C 101.991 174.415, 105.469 193.342, 107.244 190.971 C 125.010 167.231, 127 164.171, 127 160.602 C 127 153.273, 130.178 141.380, 134.570 132.277 C 143.484 113.796, 160.347 100.154, 180.714 94.945 C 190.031 92.562, 204.789 92.391, 213.985 94.558 C 221.411 96.308, 232.677 101.493, 238.438 105.813 L 242.376 108.766 250.272 102.339 C 254.615 98.804, 259.030 95.373, 260.084 94.715 C 261.138 94.057, 262 93.175, 262 92.755 C 262 91.139, 246.087 80.323, 238.482 76.772 C 234.092 74.722, 226.900 72.107, 222.500 70.962 C 212.107 68.258, 191.437 67.478, 181.342 69.409 M 137.475 224.225 L 129.673 234.381 134.462 238.716 C 145.421 248.638, 162.683 256.995, 179.319 260.431 C 188.769 262.383, 206.440 262.458, 216.162 260.589 C 225.981 258.700, 238.919 253.871, 246.943 249.099 C 254.636 244.524, 264.214 237.085, 263.793 236.010 C 263.408 235.025, 246.332 221, 245.517 221 C 245.173 221, 242.327 222.738, 239.195 224.862 C 225.561 234.106, 213.500 238, 198.500 238 C 180.868 238, 164.346 231.724, 152.080 220.368 L 145.276 214.068 137.475 224.225" fill={`url(#${gid})`} fillRule="evenodd" />
      <path d="M 184.500 109.716 C 177.419 112.572, 175.318 114.761, 162.370 132.783 C 144.552 157.583, 111.716 202.601, 88.177 234.500 C 77.219 249.350, 68.378 261.725, 68.529 262 C 68.680 262.275, 74.448 262.362, 81.346 262.194 L 93.888 261.887 111.318 238.194 C 120.905 225.162, 137.122 203.281, 147.356 189.568 L 165.964 164.637 166.232 189.517 L 166.500 214.397 174.072 217.658 C 178.236 219.452, 183.524 221.220, 185.822 221.587 L 190 222.256 190 165.128 C 190 133.708, 189.662 108.023, 189.250 108.052 C 188.838 108.080, 186.700 108.829, 184.500 109.716" fill="#2F9BFF" fillRule="evenodd" />
      <path d="M 206 165 C 206 196.678, 206.383 221, 206.882 221 C 207.367 221, 212.655 218.825, 218.632 216.167 L 229.500 211.334 229.500 164.951 L 229.500 118.568 219 113.861 C 213.225 111.273, 207.938 109.120, 207.250 109.077 C 206.264 109.016, 206 120.825, 206 165" fill="#d9dbe0" fillRule="evenodd" />
    </svg>
  )
}
