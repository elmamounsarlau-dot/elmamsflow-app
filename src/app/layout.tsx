import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { themeMode } from '@/lib/theme';

const manrope = localFont({ src: './fonts/manrope.woff2', variable: '--font-manrope', weight: '200 800', display: 'swap' });
const sora = localFont({ src: './fonts/sora.woff2', variable: '--font-sora', weight: '100 800', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Elmamsflow', template: '%s · Elmamsflow' },
  description: 'Your Elmamsflow workspace.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mode = await themeMode();
  return (
    <html lang="en" className={`${manrope.variable} ${sora.variable}`} data-theme={mode === 'system' ? undefined : mode} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
