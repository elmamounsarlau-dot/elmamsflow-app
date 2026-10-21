import 'server-only';
import { cookies } from 'next/headers';

export type ThemeMode = 'light' | 'dark' | 'system';
export async function themeMode(): Promise<ThemeMode> {
  const v = (await cookies()).get('elm_theme')?.value;
  return v === 'light' || v === 'dark' ? v : 'system';
}
