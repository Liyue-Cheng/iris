import { useTranslation } from 'react-i18next';
import type { TerminalRecovery } from '@renderer/terminal/replay-controller';

export function TerminalRecoveryBanner({ recovery, retry }: {
  recovery: TerminalRecovery;
  retry: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="status" className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 border-b bg-background px-3 py-2 text-xs">
      <span>{t(recovery.exhausted ? 'errors.terminalRecoveryFailed' : 'errors.terminalRecovering')}
        {recovery.exhausted && ' ' + recovery.reason}
      </span>
      {recovery.exhausted && <button className="shrink-0 underline" onClick={retry}>{t('health.retry')}</button>}
    </div>
  );
}
