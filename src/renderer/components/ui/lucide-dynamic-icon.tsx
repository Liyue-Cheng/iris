import { Suspense } from 'react';
import { CircleHelp } from 'lucide-react';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { LUCIDE_ICON_NAMES } from '@shared/lucide-icon-names';

const iconNameSet = new Set<string>(LUCIDE_ICON_NAMES);

export { LUCIDE_ICON_NAMES };

export function isLucideIconName(name: string): name is IconName {
  return iconNameSet.has(name);
}

export function LucideDynamicIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}): JSX.Element {
  if (!isLucideIconName(name)) return <CircleHelp className={className} />;
  return (
    <Suspense fallback={<CircleHelp className={className} />}>
      <DynamicIcon name={name} className={className} />
    </Suspense>
  );
}
