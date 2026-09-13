import type { WindowChromeService } from './types';

export function createWindowChromeService(platform: NodeJS.Platform): WindowChromeService {
  return {
    options: (icon) => platform === 'win32'
      ? { frame: false, ...(icon ? { icon } : {}) }
      : platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 }, ...(icon ? { icon } : {}) }
        : { ...(icon ? { icon } : {}) },
    shouldQuitWhenLastWindowCloses: () => platform !== 'darwin',
  };
}
