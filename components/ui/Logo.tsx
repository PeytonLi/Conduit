export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" height={size} viewBox="0 0 32 32" width={size}>
      <defs>
        <linearGradient id="conduit-mark" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#3a9a89" />
          <stop offset="1" stopColor="#164e45" />
        </linearGradient>
      </defs>
      <rect fill="url(#conduit-mark)" height="32" rx="9" width="32" />
      <path d="M7 19.5c3.2 0 3.6-7 7-7s3.8 7 7 7" fill="none" stroke="#fbf8f3" strokeLinecap="round" strokeWidth="2.6" />
      <circle cx="24.5" cy="11.5" fill="#f2a27c" r="2.6" />
    </svg>
  );
}
