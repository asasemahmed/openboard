import { cycleTheme, THEME_ORDER, type ThemePref, useTheme } from '../lib/theme.js';
import { IconButton } from '../ui/Button.js';
import type { IconName } from '../ui/Icon.js';

const ICON: Record<ThemePref, IconName> = { system: 'system', light: 'sun', dark: 'moon' };
const NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeToggle() {
  const { pref } = useTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length] ?? 'system';
  return (
    <IconButton
      icon={ICON[pref]}
      label={`Theme: ${NAME[pref]}. Switch to ${NAME[next].toLowerCase()}`}
      onClick={() => cycleTheme()}
    />
  );
}

export const THEME_NAMES = NAME;
